import os
import asyncio
from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
import PyPDF2
from io import BytesIO
import google.generativeai as genai
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_community.vectorstores import FAISS
import numpy as np
from dotenv import load_dotenv

load_dotenv()


try:
    GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY")
    if not GOOGLE_API_KEY:
        raise ValueError("GOOGLE_API_KEY environment variable not set.")
    genai.configure(api_key=GOOGLE_API_KEY)
except ValueError as e:
    print(f"Error: {e}")
    print("Please set the GOOGLE_API_KEY environment variable.")
    exit(1)


# --- INITIALIZATION ---
app = FastAPI()

# Mount static files (CSS, JS)
app.mount("/static", StaticFiles(directory="static"), name="static")

# Setup templates
templates = Jinja2Templates(directory="templates")

# In-memory storage for document context (for simplicity in this example)
# In a production app, you would use a more robust session management system
# and potentially a persistent vector store or a caching layer.
document_store = {}

class QueryRequest(BaseModel):
    query: str
    session_id: str

# --- HELPER FUNCTIONS ---

def get_pdf_text(pdf_bytes: bytes) -> str:
    """Extracts text from PDF bytes."""
    try:
        pdf_reader = PyPDF2.PdfReader(BytesIO(pdf_bytes))
        text = ""
        for page in pdf_reader.pages:
            text += page.extract_text() or ""
        return text
    except Exception as e:
        print(f"Error reading PDF: {e}")
        return ""

def get_text_chunks(text: str) -> list[str]:
    """Splits text into manageable chunks."""
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=10000,
        chunk_overlap=1000
    )
    chunks = text_splitter.split_text(text)
    return chunks

def create_vector_store(text_chunks: list[str], session_id: str):
    """Creates and stores a FAISS vector store for a session."""
    try:
        embeddings = GoogleGenerativeAIEmbeddings(model="models/embedding-001")
        vector_store = FAISS.from_texts(text_chunks, embedding=embeddings)
        document_store[session_id] = vector_store
        print(f"Vector store created for session: {session_id}")
    except Exception as e:
        print(f"Error creating vector store: {e}")
        raise HTTPException(status_code=500, detail="Could not create vector store.")

async def generate_response_stream(vector_store, user_query):
    """Generates a response using RAG and streams it."""
    try:
        docs = vector_store.similarity_search(user_query, k=3)
        context = "\n".join([doc.page_content for doc in docs])

        model = genai.GenerativeModel('gemini-1.5-flash-latest')

        # This is the core prompt engineering for LegiClarify
        prompt = f"""
        You are "DemiDoc", a highly intelligent AI assistant designed to demystify complex legal documents. Your role is to be a reliable, private, and supportive first point of contact for users.

        **CRITICAL INSTRUCTIONS:**
        1.  **DO NOT PROVIDE LEGAL ADVICE.** Never suggest actions, interpret enforceability, or offer opinions on the user's situation.
        2.  **ALWAYS START YOUR RESPONSE WITH A DISCLAIMER.** The first thing you say must be: "🚨 **Disclaimer:** I am an AI assistant and not a lawyer. This analysis is for informational purposes only and does not constitute legal advice. Please consult with a qualified legal professional for any legal concerns."
        3.  **Use the provided context** from the user's document to answer the question accurately. Do not invent information.
        4.  **Explain complex clauses and terms in simple, practical language.** Break down jargon into easy-to-understand concepts.
        5.  **Be objective and neutral.** Stick to explaining what the document says.
        6.  **If the context does not contain the answer, state that clearly.** Say: "Based on the provided document, I could not find specific information regarding your question."
        7.  If asked about you or what you are tell them what you are. 
        **USER'S DOCUMENT CONTEXT:**
        ---
        {context}
        ---

        **USER'S QUESTION:**
        "{user_query}"

        **YOUR EXPLANATION:**
        """

        response_stream = await model.generate_content_async(prompt, stream=True)

        yield "event: start\ndata: start\n\n"
        async for chunk in response_stream:
            if chunk.text:
                # SSE (Server-Sent Events) format
                encoded_text = chunk.text.replace('\n', '<br>')
                yield f"data: {encoded_text}\n\n"
                await asyncio.sleep(0.02) # Small delay for streaming effect
        yield "event: end\ndata: end\n\n"

    except Exception as e:
        print(f"Error during response generation: {e}")
        yield f"event: error\ndata: An error occurred while generating the response.\n\n"


# --- API ENDPOINTS ---

@app.get("/")
async def read_root(request: Request):
    """Serves the main HTML page."""
    return templates.TemplateResponse("index.html", {"request": request})

@app.post("/upload/{session_id}")
async def upload_document(session_id: str, file: UploadFile = File(...)):
    """Handles file upload, processing, and vector store creation."""
    if file.content_type != 'application/pdf':
        raise HTTPException(status_code=400, detail="Invalid file type. Please upload a PDF.")

    try:
        pdf_bytes = await file.read()
        raw_text = get_pdf_text(pdf_bytes)

        if not raw_text:
            raise HTTPException(status_code=400, detail="Could not extract text from the PDF.")

        text_chunks = get_text_chunks(raw_text)
        create_vector_store(text_chunks, session_id)

        # Return a summary or confirmation
        summary_prompt = "Provide a brief, one-paragraph summary of this legal document."
        model = genai.GenerativeModel('gemini-1.5-flash-latest')
        response = await model.generate_content_async(raw_text[:20000] + "\n\n" + summary_prompt)

        return JSONResponse(content={
            "status": "success",
            "filename": file.filename,
            "initial_summary": response.text
        })
    except Exception as e:
        print(f"Upload failed: {e}")
        raise HTTPException(status_code=500, detail=f"An error occurred during file processing: {str(e)}")


@app.post("/query")
async def handle_query(request: QueryRequest):
    """Handles user queries and streams back the AI's response."""
    session_id = request.session_id
    user_query = request.query

    if session_id not in document_store:
        raise HTTPException(status_code=404, detail="Document not found or session expired. Please upload the document again.")

    vector_store = document_store.get(session_id)
    if not vector_store:
        raise HTTPException(status_code=500, detail="Vector store not available for this session.")

    return StreamingResponse(
        generate_response_stream(vector_store, user_query),
        media_type="text/event-stream"
    )



