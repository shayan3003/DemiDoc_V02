document.addEventListener('DOMContentLoaded', () => {
    // --- STATE MANAGEMENT ---
    let sessionId = null;
    let eventSource = null;

    // --- DOM ELEMENTS ---
    const uploadSection = document.getElementById('upload-section');
    const chatSection = document.getElementById('chat-section');
    const dropZone = document.getElementById('drop-zone');
    const pdfUpload = document.getElementById('pdf-upload');
    const dropZoneText = document.getElementById('drop-zone-text');
    const uploadStatus = document.getElementById('upload-status');
    const filenameDisplay = document.getElementById('filename');
    const initialSummaryDisplay = document.getElementById('initial-summary');
    const chatWindow = document.getElementById('chat-window');
    const userInput = document.getElementById('user-input');
    const sendButton = document.getElementById('send-button');
    const resetButton = document.getElementById('reset-button');

    // --- UTILITY FUNCTIONS ---
    const markdownConverter = new showdown.Converter();

    function generateSessionId() {
        return 'sess_' + Date.now() + Math.random().toString(36).substring(2, 15);
    }
    
    function sanitizeHTML(str) {
        const temp = document.createElement('div');
        temp.textContent = str;
        return temp.innerHTML;
    }

    // --- UI TRANSITIONS ---
    function showChatView() {
        uploadSection.classList.add('hidden');
        chatSection.classList.remove('hidden');
    }

    function showUploadView() {
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
        sessionId = null;
        chatSection.classList.add('hidden');
        uploadSection.classList.remove('hidden');
        chatWindow.innerHTML = '';
        userInput.value = '';
        uploadStatus.textContent = '';
        dropZoneText.innerHTML = 'Drag & drop your PDF here, or <span class="font-semibold text-blue-600">click to select file</span>';
    }

    // --- CHAT UI FUNCTIONS ---
    function appendMessage(sender, text) {
        let content;
        if (sender === 'user') {
            content = sanitizeHTML(text);
        } else {
            // Render markdown for AI responses
            content = markdownConverter.makeHtml(text);
        }
        
        const messageClass = sender === 'user' ? 'bg-blue-50 text-blue-900 self-end' : 'bg-slate-100 text-slate-800 self-start';
        const messageHTML = `<div class="message prose prose-sm max-w-full rounded-lg px-4 py-2 ${messageClass}">${content}</div>`;
        chatWindow.innerHTML += messageHTML;
        chatWindow.scrollTop = chatWindow.scrollHeight;
        return chatWindow.lastElementChild;
    }
    
    function showTypingIndicator() {
        const indicatorHTML = `
            <div id="typing-indicator" class="message bg-slate-100 text-slate-800 self-start rounded-lg px-4 py-3">
                <div class="typing-indicator">
                    <span></span><span></span><span></span>
                </div>
            </div>`;
        chatWindow.innerHTML += indicatorHTML;
        chatWindow.scrollTop = chatWindow.scrollHeight;
    }

    function removeTypingIndicator() {
        const indicator = document.getElementById('typing-indicator');
        if (indicator) {
            indicator.remove();
        }
    }


    // --- CORE LOGIC: FILE HANDLING ---
    async function handleFileUpload(file) {
        if (!file || file.type !== 'application/pdf') {
            uploadStatus.textContent = 'Error: Please select a PDF file.';
            uploadStatus.classList.add('text-red-500');
            return;
        }

        sessionId = generateSessionId();
        const formData = new FormData();
        formData.append('file', file);

        uploadStatus.textContent = `Uploading & analyzing ${file.name}...`;
        uploadStatus.classList.remove('text-red-500');
        dropZoneText.textContent = `Processing...`;

        try {
            const response = await fetch(`/upload/${sessionId}`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.detail || 'File processing failed.');
            }

            const data = await response.json();
            filenameDisplay.textContent = data.filename;
            initialSummaryDisplay.innerHTML = markdownConverter.makeHtml(data.initial_summary);
            
            showChatView();
            appendMessage('ai', "Hello! I've analyzed your document. What would you like to know? Feel free to ask me to explain specific clauses or define any terms.");

        } catch (error) {
            console.error('Upload Error:', error);
            uploadStatus.textContent = `Error: ${error.message}`;
            uploadStatus.classList.add('text-red-500');
            showUploadView();
        }
    }


    // --- CORE LOGIC: CHAT HANDLING ---
    async function handleSendMessage() {
        const query = userInput.value.trim();
        if (!query || !sessionId) return;

        appendMessage('user', query);
        userInput.value = '';
        adjustTextareaHeight();
        sendButton.disabled = true;
        showTypingIndicator();

        let aiMessageElement = null;

        try {
            const response = await fetch('/query', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query: query, session_id: sessionId }),
            });

            if (!response.ok) {
                throw new Error(`Server error: ${response.statusText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullResponse = '';

            // Process the stream
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('event: start')) {
                        removeTypingIndicator();
                        aiMessageElement = appendMessage('ai', '');
                        aiMessageElement.innerHTML = '<div class="prose prose-sm max-w-full"></div>';
                    } else if (line.startsWith('data:')) {
                        const data = line.substring(5).trim();
                        if (data === 'end') continue;
                        if (aiMessageElement) {
                            fullResponse += data.replace(/<br>/g, '\n');
                            aiMessageElement.querySelector('.prose').innerHTML = markdownConverter.makeHtml(fullResponse);
                            chatWindow.scrollTop = chatWindow.scrollHeight;
                        }
                    } else if (line.startsWith('event: end')) {
                        return; // Stream finished
                    } else if (line.startsWith('event: error')) {
                         throw new Error('An error occurred on the server.');
                    }
                }
            }

        } catch (error) {
            console.error('Query Error:', error);
            removeTypingIndicator();
            appendMessage('ai', `Sorry, an error occurred: ${error.message}. Please try again.`);
        } finally {
            sendButton.disabled = false;
        }
    }

    function adjustTextareaHeight() {
        userInput.style.height = 'auto';
        userInput.style.height = (userInput.scrollHeight) + 'px';
    }

    // --- EVENT LISTENERS ---
    dropZone.addEventListener('click', () => pdfUpload.click());
    pdfUpload.addEventListener('change', () => {
        if (pdfUpload.files.length > 0) {
            handleFileUpload(pdfUpload.files[0]);
        }
    });

    // Drag and Drop functionality
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, false);
    });
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('bg-slate-100', 'border-blue-500'), false);
    });
    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('bg-slate-100', 'border-blue-500'), false);
    });
    dropZone.addEventListener('drop', (e) => {
        if (e.dataTransfer.files.length > 0) {
            pdfUpload.files = e.dataTransfer.files;
            handleFileUpload(e.dataTransfer.files[0]);
        }
    });

    sendButton.addEventListener('click', handleSendMessage);
    userInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    });
    userInput.addEventListener('input', adjustTextareaHeight);

    resetButton.addEventListener('click', showUploadView);

    // --- INITIALIZATION ---
    showUploadView(); // Start in the upload state
});

