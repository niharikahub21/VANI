# VoiceLayer

A persistent, voice-first Chrome extension overlay that lets users search the web, take notes, and set reminders using their voice—on any website, without switching tabs—while seamlessly handling real-time interruptions.

Built for the *Rime Hackathon Challenge* (DataForge x Pathway x Rime).

## Problem Statement

Voice assistants today are confined to a single dedicated app or tab. If a user is browsing or working on any website and wants voice-based help, they must stop, switch context, and interact with a separate app. Most voice assistants also fail to handle interruptions gracefully — if a user speaks again while the assistant is still responding, the assistant either ignores the new input or continues delivering a now-irrelevant, stale response.

*Removing voice from this product would make it materially worse*: the entire value proposition is a hands-free, in-context assistant. Without spoken input and output, there is no "layer" — just another text-based tool the user would have to type into, defeating the purpose of staying heads-down in their existing task.

## What It Does

1. User presses *Ctrl+Shift+V* on any webpage to open a floating voice overlay.
2. The overlay listens continuously using the browser's speech recognition.
3. The user's spoken command is sent to a backend, which classifies the intent (*search, **note, or **reminder*) using an LLM.
4. For search queries, live web results are fetched and summarized.
5. The response is converted to natural speech using *Rime* and played back to the user.
6. *Core feature — Interruption & Recovery:* If the user speaks again while the assistant is still processing or speaking, the system immediately cancels the in-flight request and stale audio, and processes the new command instead — without ever surfacing the outdated response.
7. A history panel lets the user review past commands and responses.

## Architecture Overview

```
     +----------------------+
     |        User          | 
     |   (speaks on any     | 
     |     webpage)         | 
     +----------------------+
                |
                |
+-------------------------------+          +-------------------------------+
| Chrome Extension              |   HTTP   | Node.js / Express             |
| (content.js, overlay UI,      |<-------->| Backend                       |
|  Web Speech API,              |          | (/api/process,                |
|  interruption-handling state) |          |  /api/history)                |
+-------------------------------+          +-------------------------------+
                                                   |
                   +-------------------------------+-------------------------------+
                   |                               |                               |
                   v                               v                               v
+-------------------------------+  +-------------------------------+  +-------------------------------+
| Google Gemini LLM             |  | Rime API                      |  | Serper API                    |
| (gemini-1.5-flash)            |  | (Text-to-Speech)              |  | (if action = search)          |
| (Intent classification &      |  | (Converts response text       |  | (Live web search data         |
|  spoken text generation)      |  |  to speech audio)             |  |  results)                     |
+-------------------------------+  +-------------------------------+  +-------------------------------+
                |
                v
+-------------------------------+           +--------------------------------+
| Supabase (PostgreSQL)         |           | Response (text + audio)        |
| (Stores notes, reminders,     | --------> | (Returned to the extension and |
|  interaction history)         |           | then played back to the user)  |
+-------------------------------+           +--------------------------------+
```
*Security note:* All API keys live only in the backend's .env file. The extension never holds any credentials — it only talks to the backend over HTTP.

**Flow:**
1. The extension captures voice input from the browser tab and streams it to the backend.
2. The backend sends the transcribed input to **Claude**, which classifies intent (search / note / reminder / general query) and generates a response or action plan.
3. Depending on intent, the backend calls **Serper** for live web search results, or **Supabase** to store/retrieve notes and reminders.
4. The final response text is sent to **Rime** for text-to-speech synthesis, and the resulting audio is streamed back to the extension for playback.
5. If new voice input arrives mid-response, the backend cancels the in-flight Claude/Rime request and immediately begins processing the new input.
   
# VoiceLayer

A persistent, voice-first browser overlay that lets users search, take notes, and set reminders using their voice — on any website, without switching tabs — and correctly handles real-time interruptions.

Built for the **Rime Hackathon Challenge** (DataForge x Pathway x Rime).

---

## Problem Statement

Voice assistants today are confined to a single dedicated app or tab. If a user is browsing or working on any website and wants voice-based help, they must stop, switch context, and interact with a separate app. Most voice assistants also fail to handle interruptions gracefully — if a user speaks again while the assistant is still responding, the assistant either ignores the new input or continues delivering a now-irrelevant, stale response.

**Removing voice from this product would make it materially worse**: the entire value proposition is a hands-free, in-context assistant. Without spoken input and output, there is no "layer" — just another text-based tool the user would have to type into, defeating the purpose of staying heads-down in their existing task.

---

## What It Does

1. User presses **Ctrl+Shift+V** on any webpage to open a floating voice overlay.
2. The overlay listens continuously using the browser's speech recognition.
3. The user's spoken command is sent to a backend, which classifies the intent (**search**, **note**, or **reminder**) using an LLM.
4. For search queries, live web results are fetched and summarized.
5. The response is converted to natural speech using **Rime** and played back to the user.
6. **Core feature — Interruption & Recovery:** If the user speaks again while the assistant is still processing or speaking, the system immediately cancels the in-flight request and stale audio, and processes the new command instead — without ever surfacing the outdated response.
7. A history panel lets the user review past commands and responses.

---

## Architecture

```
USER (speaks on any webpage)
   |
CHROME EXTENSION (content.js)
   - Floating overlay UI
   - Browser's Web Speech API (speech-to-text)
   - Interruption-handling state machine (AbortController + request IDs)
   |
BACKEND (Node.js + Express)
   - POST /api/process — receives transcript, orchestrates the response
   - GET  /api/history — returns past interactions
   |
LLM (Google Gemini API — gemini-1.5-flash)
   - Classifies intent (search / note / reminder)
   - Generates natural-language spoken response text
   |
   (if action = search) --> SERPER API (live web search results)
   |
RIME API  <-- PRIMARY SPOKEN OUTPUT
   - Converts the final response text into speech audio
   |
SUPABASE (PostgreSQL)
   - Stores notes, reminders, and interaction history
   |
Response (text + audio) returned to the extension --> played back to the user
```

**Security note:** All API keys live only in the backend's `.env` file. The extension never holds any credentials — it only talks to the backend over HTTP.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Chrome Extension (Manifest V3), vanilla JavaScript |
| Speech-to-Text | Browser's native Web Speech API |
| Backend | Node.js + Express |
| LLM / Reasoning | Google Gemini API (`gemini-1.5-flash`) |
| Voice Output (TTS) | **Rime API** |
| Web Search | Serper API |
| Database | Supabase (PostgreSQL) |
| Version Control | Git + GitHub |

---

## Rime Integration Details

> Fill in the exact values used in the final submitted build before judging.

| Field | Value |
|---|---|
| Rime Model ID | `[FILL IN — e.g. mistv2 / arcana]` |
| Speaker / Voice | `[FILL IN — exact voice name from Rime's live catalog]` |
| Language | `[FILL IN — e.g. en-IN / en-US]` |
| Endpoint | `[FILL IN — exact regional endpoint URL used]` |
| Audio Format | `[FILL IN — e.g. mp3, wav, mulaw]` |
| Transport | Base64-encoded audio returned over HTTP from backend to extension, played via the browser's `Audio` object |
| Fallback Behavior | `[FILL IN — describe what happens if Rime is unreachable, if any fallback exists, and how it is surfaced to the user]` |

---

## Setup Instructions

### Prerequisites
- Node.js (v18+)
- Google Chrome
- API keys for: Google Gemini, Rime, Serper, Supabase

### 1. Clone the repository
```bash
git clone https://github.com/[your-username]/voicelayer.git
cd voicelayer
```

### 2. Backend Setup
```bash
cd backend
npm install
```

Create a `.env` file in `backend/` (see `.env.example` for the required keys):
```
GEMINI_API_KEY=your_key_here
RIME_API_KEY=your_key_here
SERPER_API_KEY=your_key_here
SUPABASE_URL=your_url_here
SUPABASE_KEY=your_key_here
PORT=3000
```

Run the backend:
```bash
node server.js
```
The server should log: `VoiceLayer backend is running on port 3000`

### 3. Database Setup (Supabase)
Run the following SQL in the Supabase SQL Editor:
```sql
create table notes (
  id serial primary key,
  content text,
  created_at timestamp default now()
);

create table reminders (
  id serial primary key,
  content text,
  reminder_time text,
  created_at timestamp default now()
);

create table history (
  id serial primary key,
  user_text text,
  action text,
  response_text text,
  created_at timestamp default now()
);
```

### 4. Load the Chrome Extension
1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension/` folder.
4. Navigate to any website and press **Ctrl+Shift+V** to open the overlay.

---

## Known Limitations

- Interruptions shorter than 3 characters are intentionally ignored, to avoid false triggers from background noise or short filler sounds.
- Speech recognition depends on the browser's built-in Web Speech API, which requires an internet connection and may occasionally return a `network` error under unstable connectivity; the extension automatically retries.
- A watchdog mechanism restarts speech recognition if it becomes unresponsive for an extended period, to maintain reliability during long sessions.
- Reminder notifications are currently logged to the database but do not yet trigger native OS-level notifications.
- The extension currently supports English voice commands; multilingual support is a planned future enhancement.

---

## Failure Behavior

If the backend is unreachable, the overlay displays: *"Error: could not reach VoiceLayer backend."* and the mic returns to an idle state, without crashing or leaving the UI in an inconsistent state. If Rime audio synthesis fails for a given response, the text response is still shown in the overlay, and the mic state resets to idle rather than remaining stuck.

---

## Team

| Member | Role |
|---|---|
| Naintika | Backend & AI Engineer — API integrations (Gemini, Rime, Serper, Supabase), server architecture |
| Niharika | Extension & Interruption Engineer — Chrome extension, overlay UI, voice input, interruption-and-recovery logic |
| Aryan | Database, Testing & Documentation — Supabase schema, systematic testing, evidence documentation |

---

## Evidence

See [`RIME_EVIDENCE.md`](./RIME_EVIDENCE.md) for the detailed acceptance test, reproduction steps, and results for the core hard-engineering claim (Interruption & Recovery).
## Tech Stack

| Layer | Technology / Tool | Role & Details |
| --- | --- | --- |
| **Frontend** | Chrome Extension (Manifest V3) | Vanilla JavaScript UI & user interactions |
| **Speech-to-Text (STT)** | Web Speech API | Native browser speech recognition |
| **Backend** | Node.js + Express | API routing & orchestration server |
| **LLM & Reasoning** | Google Gemini API (`gemini-3.6-flash`) | Core intelligence, context & prompt processing |
| **Voice Output (TTS)** | Rime API | Ultra-low latency voice synthesis |
| **Web Search** | Serper API | Real-time web results retrieval |
| **Database** | Supabase (PostgreSQL) | Data persistence, auth & state management |
| **Version Control** | Git + GitHub | Source code management & CI/CD |
---
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
- Multi-user support is not yet implemented; data is currently managed on a single-user/session basis.

## Team Members

- **Naintika** — Backend
- **Niharika** — Extension
- **Aryan** — Database & Testing
  
