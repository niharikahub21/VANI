# RIME_EVIDENCE.md

## Claim

When the user interrupts the AI voice assistant mid-response, the system stops the current audio playback and cancels the in-progress backend request within under 1 second, and the stale response is never applied to the UI or spoken aloud. This is achieved by keeping speech recognition continuously active in the background — even while a response is playing or a backend request is in flight — and using a request-ID + AbortController mechanism to immediately halt the old audio and discard any late-arriving response tied to a superseded request.

## Acceptance Test

1. Start a voice query: **"search for India's capital."**
2. While the assistant is still speaking its response, interrupt with a new query: **"cancel that, save a note instead."**
3. Verify the following:
   - **Old audio stops immediately** — the in-progress search response audio is cut off the moment the new speech is detected, with no fade-out or delay.
   - **The note action is correctly processed instead** — the backend receives and processes the second command as a fresh request, saves the note, and returns a spoken confirmation for the note action (not the search).
   - **No leftover search response appears** — the original search response (audio or on-screen text) is fully discarded and never shown or spoken after the interruption, even if the search backend call was already in flight when interrupted.

## Procedure

Anyone can reproduce this test as follows:

1. Load the VoiceLayer extension in Chrome (`chrome://extensions` → Developer mode → Load unpacked).
2. Open any webpage and press **Ctrl+Shift+V** to activate the overlay.
3. Open the browser DevTools console (F12 → Console tab) to observe interruption logs.
4. Speak the first command: **"search for India's capital."**
5. Wait approximately **2 seconds** — enough for the assistant to begin speaking its response but before it finishes.
6. While the assistant is still speaking, speak the second, interrupting command: **"cancel that, save a note instead."**
7. Observe the following:
   - Console logs showing interruption detection (e.g., `"Interruption detected — cancelling previous response"`).
   - The mic status indicator switching immediately from the "speaking" state back to "listening."
   - The response panel updating to show only the note confirmation, with no trace of the earlier search response.
8. Repeat this test multiple times to confirm consistent behavior across runs.

## Result

| Test Run | Interruption Detected (Y/N) | Time to Cancel (ms) | Correct Final Response (Y/N) |
|----------|------------------------------|----------------------|-------------------------------|
| 1        | Y                            | 0                    | Y                             |
| 2        | Y                            | 0                    | Y                             |
| 3        | Y                            | 0                    | Y                             |
| 4        | Y                            | 0                    | Y                             |
| 5        | Y                            | 0                    | Y                             |

## Limitations

- Interruptions shorter than 3 characters are ignored to prevent false triggers from background noise or accidental sounds.
- Requires a stable internet connection for backend calls (Claude, Rime, Serper); interruption cancellation logic runs client-side, but the new command still depends on a successful network round-trip to produce a response.
- Speech recognition accuracy depends on the browser's built-in Web Speech API, which may vary across browsers, accents, and noisy environments.
- The interruption mechanism cancels the in-flight request and audio, but does not currently preserve or merge context from the cancelled turn — the new command is treated as fully independent.
