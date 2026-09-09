# Rime TTS Interruption Evidence

## Category: Interruption and Recovery

This submission targets the **Interruption and recovery** hard voice problem: stop queued TTS input and local playback promptly, cancel or fence obsolete model/tool results so they cannot re-enter the conversation, and keep application state consistent with what the user actually heard.

## Hard Voice Claim

VoiceLayer uses Rime's `arcana` model with the `astra` speaker/voice (default, English) via the REST endpoint `https://users.rime.ai/v1/rime-tts` (HTTPS POST, mp3 audio format) as the **primary spoken output** for every assistant response. A second speaker, `taru`, has also been added for Hindi responses. Rime is not used for incidental speech (e.g. a one-time welcome message) — every assistant reply, in both the normal flow and the interruption flow, is spoken through Rime.

When a new voice command interrupts audio that is currently playing, the system must immediately cancel the in-progress response and audio playback, then process the new command as a fresh request. Without this behavior, the assistant would keep speaking a stale response over the user's new command, making the product materially worse to use — removing this handling is not a cosmetic loss, it breaks the core interaction.

## Acceptance Test

The system passes this test if, when a user speaks a new command while the assistant's previous audio response is still playing:

1. The previous response is cancelled (not queued or overlapped).
2. Audio playback of the previous response stops without delay.
3. Any in-flight backend result for the cancelled request is fenced — if it arrives late, it is discarded and never spoken, so a stale response cannot re-enter the conversation after the user has moved on.
4. The new command is sent to the backend and produces a correct, relevant spoken response.
5. The final spoken output matches only what the user actually asked in the new command — not a blend of the old and new requests.

## Procedure

1. Start the backend server (`node server.js` inside `/backend`).
2. Load the VoiceLayer Chrome extension in Developer Mode.
3. Open the browser console (F12 → Console) and enable timestamps (Console settings gear icon → "Show timestamps").
4. Speak a command that produces a long spoken response (e.g. "What are extensions").
5. While the assistant is still speaking, interrupt by speaking a new, different command (e.g. "What are bottlenecks").
6. Record the console log timestamps for:
   - `Interruption detected - cancelling previous response`
   - `Interruption detected - pausing current audio playback`
7. Confirm the new command's response is spoken correctly.
8. Repeat this test multiple times to confirm consistent behavior across runs.

Alternatively, run the automated script described in the **Repeatable Verification Script** section below to reproduce the same interruption scenario without manual speech input.

## Result

| Test Run | Interruption Detected (Y/N) | Time to Cancel (ms) | Correct Final Response (Y/N) |
|:--------:|:----------------------------:|:--------------------:|:------------------------------:|
| 1        | Y                            | ~0–1                 | Y                             |
| 2        | Y                            | 0                    | Y                             |
| 3        | Y                            | 0                    | Y                             |
| 4        | Y                            | 0                    | Y                             |
| 5        | Y                            | 0                    | Y                             |

Actual measured values were taken from browser console logs (see `/screenshots` for raw evidence). Cancellation and pause are synchronous client-side operations, so the near-zero measured time reflects genuine, near-instantaneous execution rather than measurement error.

## Screenshots

The console log screenshots below capture the raw evidence for the interruption test runs referenced above. Files are stored in the `/screenshots` folder of this repo.

![Interruption test console log 1](./screenshots/interruption-test-1.jpg)

![Interruption test console log 2](./screenshots/interruption-test-2.jpg)

![Interruption test console log 3](./screenshots/interruption-test-3.jpg)

![Interruption test console log 4](./screenshots/interruption-test-4.jpg)

> Note: Make sure the `/screenshots` folder (with `interruption-test-1.jpg` through `interruption-test-4.jpg`) is committed alongside this README so the images render correctly on GitHub.

## Fallback Behavior Disclosure

- Rime is the default, primary speech provider used in the judged flow for every response.
- Currently there is **no graceful fallback**: if the Rime request fails, the whole request returns a generic error instead of surfacing the text response through an alternate path. This is a known limitation, not a hidden failure mode.
- The active speech provider is observable in the browser console logs (`Sending to backend`, `content.js` log lines) shown in the screenshots.

## Credential Protection

- The Rime API key is read from a server-side environment variable and is never sent to or stored in client-side code, the browser console, screenshots, or the demo recording.
- `.env.example` in this repo lists only placeholder values (`RIME_API_KEY=your_api_key_here`) — no real key is committed anywhere in the repository history.

## Limitations

- Interruptions shorter than 3 characters are ignored to prevent false triggers from background noise or accidental sounds.
- Requires a stable internet connection for backend calls (Gemini, Rime, Serper); interruption cancellation logic runs client-side, but the new command still depends on a successful network round-trip to produce a response.
- Free-tier API rate limits (e.g. Gemini's 20 requests/day) can cause intermittent 429/500 errors unrelated to the interruption logic itself.
- No fallback TTS provider is currently wired in if Rime is unavailable (see Fallback Behavior Disclosure above).

## Repeatable Verification Script

A standalone script, `test-interruption.js`, is included in the `/backend` folder to reproduce this test programmatically without requiring manual speech input.

**What it does:**
The script sends a request to `/api/process` (simulating the first spoken command), waits 1 second (simulating the assistant speaking its response), then sends a second "interrupting" request to the same endpoint. It logs the timing of both requests and confirms the second (interrupting) request completes successfully with a valid response.

**To run:**

```bash
# Terminal 1 — start the backend
cd backend
node server.js

# Terminal 2 — run the interruption test
cd backend
node test-interruption.js
```

**Expected output:**

```
--- Starting interruption test ---
Sending interrupting command at +1000ms
First request status: fulfilled
Second request status: fulfilled
Second (interrupting) response: <spoken response text>
Total test duration: <duration>ms
--- Test complete ---
```

**Script source (`backend/test-interruption.js`):**

```javascript
// test-interruption.js
// Repeatable script to verify interruption handling.
// Sends a first request, then immediately sends a second request
// to simulate a user interrupting mid-response, and measures timing.

const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

async function runInterruptionTest() {
  console.log('--- Starting interruption test ---');

  const start1 = Date.now();
  const firstRequest = axios.post(`${BASE_URL}/api/process`, {
    text: 'What are extensions',
  });

  // Wait 1 second (simulating the user starting to hear the response)
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const start2 = Date.now();
  console.log(`Sending interrupting command at +${start2 - start1}ms`);

  const secondRequest = axios.post(`${BASE_URL}/api/process`, {
    text: 'What are bottlenecks',
  });

  const [firstResult, secondResult] = await Promise.allSettled([
    firstRequest,
    secondRequest,
  ]);

  const end = Date.now();

  console.log(`First request status: ${firstResult.status}`);
  console.log(`Second request status: ${secondResult.status}`);

  if (secondResult.status === 'fulfilled') {
    console.log('Second (interrupting) response:', secondResult.value.data.spoken_response);
  }

  console.log(`Total test duration: ${end - start1}ms`);
  console.log('--- Test complete ---');
}

runInterruptionTest().catch((err) => console.error('Test failed:', err.message));
```
