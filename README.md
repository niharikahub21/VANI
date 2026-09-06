# VoiceLayer

A Chrome extension that adds a persistent, voice-controlled assistant overlay to any website — search the web, save notes, and set reminders, all hands-free.

## Problem Statement

Voice assistants today are either locked into a single app (Siri, Alexa), or require switching tabs and context to use a separate tool. Meanwhile, most everyday browsing tasks — quick searches, jotting a note, setting a reminder — still require breaking flow to type. There's no lightweight, always-available voice layer that works *on top of* whatever site you're already using, and handles natural conversational interruptions the way a human assistant would.

## What It Does

VoiceLayer injects a floating voice assistant overlay into any webpage, toggled with **Ctrl+Shift+V**. Once active, users can simply speak to:

- **Search the web** — ask a question and get a spoken, synthesized answer
- **Save notes** — dictate a note to be stored and retrieved later
- **Set reminders** — voice-create reminders without leaving the page

The core engineering challenge we tackled is **interruption and recovery**: if the user starts speaking while the assistant is still responding, the in-progress response is immediately cancelled and the new input takes over — just like a natural conversation, with no waiting for the assistant to "finish."

## Architecture Overview

```
+----------------------+          +----------------------+
|  Chrome Extension    |  HTTP    |  Node.js / Express   |
|  (overlay UI, mic    |<-------->|  Backend             |
|  capture, audio      |          |                      |
|  playback)           |          |                      |
+----------------------+          +------------+---------+
                                               |
                    +--------------------------+--------------------------+
                    |                          |                          |
                    v                          v                          v
             +-------------+           +-------------+           +-------------+
             |   Claude    |           |    Rime     |           |   Serper    |
             | (intent +   |           |  (text-to-  |           | (web search)|
             |  reasoning) |           |   speech)   |           |             |
             +-------------+           +-------------+           +-------------+
                                               |
                                               v
                                        +-------------+
                                        |  Supabase   |
                                        | (notes,     |
                                        |  reminders) |
                                        +-------------+
```

**Flow:**
1. The extension captures voice input from the browser tab and streams it to the backend.
2. The backend sends the transcribed input to **Claude**, which classifies intent (search / note / reminder / general query) and generates a response or action plan.
3. Depending on intent, the backend calls **Serper** for live web search results, or **Supabase** to store/retrieve notes and reminders.
4. The final response text is sent to **Rime** for text-to-speech synthesis, and the resulting audio is streamed back to the extension for playback.
5. If new voice input arrives mid-response, the backend cancels the in-flight Claude/Rime request and immediately begins processing the new input.

## Tech Stack

- **Frontend:** Chrome Extension (Manifest V3), JavaScript/HTML/CSS
- **Backend:** Node.js, Express
- **Intent & Reasoning:** Claude (Anthropic API)
- **Text-to-Speech:** Rime
- **Web Search:** Serper API
- **Data Storage:** Supabase (notes, reminders, user data)

## Setup Instructions

### Backend

```bash
git clone <repo-url>
cd voicelayer/backend
npm install
```

Create a `.env` file in `backend/` with:

```
ANTHROPIC_API_KEY=your_claude_api_key
RIME_API_KEY=your_rime_api_key
SERPER_API_KEY=your_serper_api_key
SUPABASE_URL=your_supabase_project_url
SUPABASE_KEY=your_supabase_service_key
PORT=3000
```

Run the server:

```bash
npm run dev
```

The backend will be available at `http://localhost:3000`.

### Chrome Extension

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `voicelayer/extension` directory.
4. Pin the extension to your toolbar for easy access.
5. On any webpage, press **Ctrl+Shift+V** to open the voice overlay.

> Make sure the backend is running locally before using the extension, or update the extension's configured API base URL to point to your deployed backend.

## Rime Model / Voice / Endpoint Details

- **Model:** `arcana`
- **Voice/Speaker:** `astra`
- **Endpoint:** `https://users.rime.ai/v1/rime-tts`
- **Audio Format:** MP3
- **Transport:** HTTPS POST (REST API)
- **API Key source:** Self-signup at [rime.ai](https://rime.ai)

## Known Limitations

- Voice recognition accuracy depends on the browser's built-in speech APIs and can degrade in noisy environments.
- Interruption handling cancels the current response but does not yet preserve partial context from the cancelled turn.
- Reminders are stored in Supabase but do not yet trigger native OS or browser notifications.
- The overlay has been tested primarily on standard content pages; behavior on heavily sandboxed or CSP-restricted sites (e.g., some banking portals) is untested.
- No multi-user account system yet — data storage is currently single-user/session-based.

## Team Members

- **Naintika** — Backend
- **Niharika** — Extension
- **Aryan** — Database & Testing
-