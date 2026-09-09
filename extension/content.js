// content.js
// This script is automatically injected into every webpage (see
// "content_scripts" in manifest.json). It has access to the page's DOM,
// so it's the only place we can actually create and show our overlay,
// listen to the microphone, and play back audio.
//
// PERF PASS NOTES (search "PERF:" for every change made in this file):
// All business logic, state machine transitions, and response formats are
// byte-for-byte identical to the original. Every change below is either
// (a) avoiding redundant work on a hot path, (b) removing a network
// round-trip's dead time, or (c) making media playback start sooner.
//
// VISUAL PASS NOTES (search "VISUAL:" for every change made in this file):
// This pass only touches how the microphone looks — it does not add,
// remove, or reorder any state transitions, timers, backend calls, or
// recognition logic. setMicState() is still called from exactly the same
// places with exactly the same states ("idle"/"listening"/"processing"/
// "speaking") as before; the VISUAL additions just make those same calls
// also drive a nicer-looking 3D mic + a reactive, symmetrical waveform.

// ---------------------------------------------------------------------------
// GLOBAL STATE
// These variables live for as long as the page is open. They track the
// speech recognizer, the accumulated transcript, and our "silence timer".
// ---------------------------------------------------------------------------

let recognition = null;        // Will hold our SpeechRecognition instance.
let silenceTimer = null;       // Will hold the setTimeout ID for the silence timer.
let finalTranscript = "";      // Accumulates confirmed ("final") speech results.
// PERF: Reduced from 1500ms -> 800ms at user's request, to cut perceived
// latency between "user stops talking" and "request goes out". This is a
// tuning value, not logic — the flow (wait for silence -> send transcript)
// is unchanged. Trade-off: shorter wait = slightly higher chance of firing
// on a mid-sentence pause (e.g. "mujhe... ek second... chahiye") and
// sending an incomplete transcript. 800msgit is a reasonably safe middle
// ground; drop further (e.g. 700ms) only if this doesn't feel like it's
// cutting people off.
const SILENCE_DELAY_MS = 800; // How long to wait after the user stops talking.

// --- Interruption-handling state --------------------------------------
// These let the user "barge in" with new speech while the AI is talking
// or while we're still waiting on a backend response, and have that
// old response get cancelled instead of playing over the new command.
let currentAudio = null;            // The Audio object currently playing (or null if none).
let currentAudioObjectUrl = null;   // PERF: the Blob URL backing currentAudio, so we can revoke it.
let currentAbortController = null;  // AbortController for the in-flight fetch (or null if none).
let currentRequestId = 0;           // Increases every time we start a "turn", so we can
                                     // tell a stale response apart from the latest one.
const MIN_INTERRUPT_CHARS = 3;      // Ignore very short blips (background noise, coughs, etc.)
                                     // when deciding whether the user is trying to interrupt.

// --- Watchdog state ------------------------------------------------------
// Speech recognition can sometimes silently "freeze" — it looks like it's
// still running, but no more onresult events ever fire, even though the
// user is talking. The watchdog below detects that and force-restarts
// recognition when it happens.
let lastActivityTime = Date.now();  // Updated every time onresult fires.
let watchdogInterval = null;        // Holds the setInterval ID so we can clear it later.
let lastWatchdogRestart = 0;        // When the watchdog last force-restarted recognition (0 = never yet).
const WATCHDOG_CHECK_MS = 5000;            // How often the watchdog checks in (5 seconds).
const WATCHDOG_STUCK_THRESHOLD_MS = 60000; // How long without activity counts as "stuck" (60 seconds).
const WATCHDOG_RESTART_COOLDOWN_MS = 30000; // Minimum gap between watchdog restarts (30 seconds),
                                             // so one restart can't immediately trigger another.

// PERF: Cached references to the three overlay elements we touch constantly
// (once per onresult event, which can fire 10-50+ times/sec while the user
// talks, plus once per backend turn). The original code called
// document.getElementById() for these every single time. getElementById is
// cheap in isolation, but on a hot path fired dozens of times a second it's
// pure repeated tree-walk overhead for zero benefit, since the overlay's DOM
// nodes never change identity once built. We resolve them once in
// buildOverlay() and reuse the references everywhere.
let micCircleEl = null;
let transcriptDivEl = null;
let responseDivEl = null;

// PERF: Backend origin, hoisted to a constant so we can also use it for the
// connection warm-up below without duplicating the string.
const BACKEND_ORIGIN = "http://localhost:3000";
const BACKEND_ENDPOINT = BACKEND_ORIGIN + "/api/process";
const HISTORY_ENDPOINT = BACKEND_ORIGIN + "/api/history";

// --- History panel state -------------------------------------------------
// Cached references to the history button/panel/list, resolved once in
// buildOverlay() (same pattern as micCircleEl/transcriptDivEl/responseDivEl
// above — avoids repeated getElementById lookups).
let historyButtonEl = null;
let historyPanelEl = null;
let historyListEl = null;
let isHistoryPanelOpen = false;

// Bumped every time we start a new history fetch, so that if the panel is
// closed/reopened quickly (or the user double-clicks the icon), a slow,
// now-stale fetch response can't render into a panel state it no longer
// matches — same "ignore the stale response" pattern used for the main
// backend request below.
let historyRequestId = 0;

// Badge colors for each action type, as requested. Anything outside this
// set (or missing) falls back to a neutral gray badge instead of guessing.
const HISTORY_ACTION_COLORS = {
  search: "#3498ff",   // blue
  note: "#2ecc71",     // green
  reminder: "#f5a623"  // orange
};
const HISTORY_ACTION_DEFAULT_COLOR = "#888888";

// ---------------------------------------------------------------------------
// VISUAL: MIC DESIGN + REACTIVE VOICE WAVES
// Everything in this section only affects appearance. It never triggers a
// state change on its own — it only reads currentMicState (set by the
// existing setMicState() calls) and renders accordingly.
// ---------------------------------------------------------------------------

const WAVE_BAR_COUNT_PER_SIDE = 5; // Bars on each side of the mic (symmetrical).
let waveBarEls = { left: [], right: [] };
let micVisualWrapperEl = null;
let micGlowEl = null;

// Smoothed volume level (0-1) the animation loop eases toward every frame,
// so bar motion is fluid instead of jumping around with raw, noisy data.
let currentWaveLevel = 0;
let waveTimePhase = 0;

// Fallback "speech activity" proxy, used only while state === "listening"
// AND the mic-input analyser below isn't available. Bumped in
// recognition.onresult (real speech events) and decays every frame, so it
// still moves in response to actual talking even without raw amplitude.
let decayingSpeechActivity = 0;

// --- Mic-input analyser (true volume reactivity while "listening") -----
// This is a SECOND, separate audio capture used only for the waveform
// visual — it never touches transcription, which still runs entirely
// through the existing SpeechRecognition object above.
let micVisAudioContext = null;
let micVisAnalyser = null;
let micVisStream = null;
let micVisDataArray = null;
let micVisInitAttempted = false;

function initMicInputAnalyserOnce() {
  if (micVisInitAttempted) {
    return;
  }
  micVisInitAttempted = true;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return; // Not available — waveform falls back to decayingSpeechActivity.
  }

  navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => {
      micVisStream = stream;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      micVisAudioContext = new AudioContextClass();
      const source = micVisAudioContext.createMediaStreamSource(stream);
      micVisAnalyser = micVisAudioContext.createAnalyser();
      micVisAnalyser.fftSize = 64;
      micVisDataArray = new Uint8Array(micVisAnalyser.frequencyBinCount);
      source.connect(micVisAnalyser);
      // Intentionally NOT connected to destination — this is only for
      // reading volume, never for playing the mic back to the user.
    })
    .catch((error) => {
      // Purely cosmetic feature — if a second getUserMedia grant is denied
      // or blocked on this page, we just keep using the speech-activity
      // fallback instead of breaking anything.
      console.error("VoiceLayer: mic waveform visualizer unavailable (non-fatal):", error);
    });
}

function teardownMicInputAnalyser() {
  if (micVisStream) {
    micVisStream.getTracks().forEach((track) => track.stop());
  }
  if (micVisAudioContext) {
    micVisAudioContext.close().catch(() => {});
  }
  micVisStream = null;
  micVisAudioContext = null;
  micVisAnalyser = null;
  micVisDataArray = null;
  micVisInitAttempted = false; // Allow re-init next time listening starts.
}

// --- Speaker-output analyser (true volume reactivity while "speaking") -
let speakerVisAudioContext = null;
let speakerVisAnalyser = null;
let speakerVisDataArray = null;

function setupSpeakerVisualizer(audioEl) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!speakerVisAudioContext) {
      speakerVisAudioContext = new AudioContextClass();
    }
    const source = speakerVisAudioContext.createMediaElementSource(audioEl);
    const analyser = speakerVisAudioContext.createAnalyser();
    analyser.fftSize = 64;
    source.connect(analyser);
    // IMPORTANT: also connect through to the speakers — Web Audio routes
    // audio explicitly, so without this line the response would go silent.
    analyser.connect(speakerVisAudioContext.destination);
    speakerVisAnalyser = analyser;
    speakerVisDataArray = new Uint8Array(analyser.frequencyBinCount);
  } catch (error) {
    // If this fails, audio.play() below is completely unaffected — we
    // simply won't have true output-volume reactivity for this turn.
    console.error("VoiceLayer: speaker waveform visualizer unavailable (non-fatal):", error);
    speakerVisAnalyser = null;
    speakerVisDataArray = null;
  }
}

function teardownSpeakerVisualizer() {
  speakerVisAnalyser = null;
  speakerVisDataArray = null;
}

function readAnalyserLevel(analyser, dataArray) {
  analyser.getByteFrequencyData(dataArray);
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    sum += dataArray[i];
  }
  const average = sum / dataArray.length / 255; // 0..1
  return Math.min(1, average * 1.6); // Slight boost so normal speech visibly moves the bars.
}

// Builds the mic + glow + wave-bar DOM cluster. Returns the outer wrapper
// (what gets appended to the overlay) and the inner core element (what the
// rest of the file keeps treating exactly like the old flat mic circle —
// same id, same classList calls from setMicState()).
//
// VISUAL: the core is no longer a plain colored circle. It's now a small
// realistic condenser-mic glyph (body + grille lines + stand), built as an
// inline SVG so it scales crisply and can still be recolored per-state via
// CSS (fill/stroke), exactly like the old background-color swap was.
function buildMicVisual() {
  const wrapper = document.createElement("div");
  wrapper.id = "voicelayer-mic-visual";

  const glow = document.createElement("div");
  glow.id = "voicelayer-mic-glow";

  const leftSide = document.createElement("div");
  leftSide.className = "voicelayer-wave-side";
  const rightSide = document.createElement("div");
  rightSide.className = "voicelayer-wave-side";

  // Left bars: array index 0 = nearest the mic (appended last, so it ends
  // up closest to the core in the DOM/visual order).
  const leftBarEls = [];
  for (let i = WAVE_BAR_COUNT_PER_SIDE - 1; i >= 0; i--) {
    const bar = document.createElement("div");
    bar.className = "voicelayer-wave-bar voicelayer-wave-left";
    leftSide.appendChild(bar);
    leftBarEls.unshift(bar);
  }

  // Right bars: array index 0 = nearest the mic (appended first, right
  // next to the core).
  const rightBarEls = [];
  for (let i = 0; i < WAVE_BAR_COUNT_PER_SIDE; i++) {
    const bar = document.createElement("div");
    bar.className = "voicelayer-wave-bar voicelayer-wave-right";
    rightSide.appendChild(bar);
    rightBarEls.push(bar);
  }

  // VISUAL: core is now an SVG mic glyph instead of a flat div circle.
  // setMicState() still targets this exact element by id/class, so all
  // existing state logic (idle/listening/processing/speaking) keeps
  // working unchanged — only what's rendered inside changed.
  const core = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  core.id = "voicelayer-mic-circle";
  core.setAttribute("viewBox", "0 0 40 64");
  core.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  core.innerHTML = `
    <defs>
      <linearGradient id="voicelayer-mic-body-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="var(--vl-mic-body-light)" />
        <stop offset="55%" stop-color="var(--vl-mic-body-mid)" />
        <stop offset="100%" stop-color="var(--vl-mic-body-dark)" />
      </linearGradient>
    </defs>
    <!-- Capsule body -->
    <rect id="voicelayer-mic-body" x="11" y="2" width="18" height="32" rx="9"
          fill="url(#voicelayer-mic-body-grad)" stroke="rgba(0,0,0,0.35)" stroke-width="0.75" />
    <!-- Grille lines across the capsule, like a real condenser mic -->
    <g id="voicelayer-mic-grille" stroke="rgba(0,0,0,0.28)" stroke-width="0.9" stroke-linecap="round">
      <line x1="12.5" y1="8"  x2="27.5" y2="8" />
      <line x1="12.5" y1="11" x2="27.5" y2="11" />
      <line x1="12.5" y1="14" x2="27.5" y2="14" />
      <line x1="12.5" y1="17" x2="27.5" y2="17" />
      <line x1="12.5" y1="20" x2="27.5" y2="20" />
      <line x1="12.5" y1="23" x2="27.5" y2="23" />
    </g>
    <!-- Glossy highlight down the left edge of the body -->
    <rect x="13" y="4.5" width="3" height="27" rx="1.5" fill="rgba(255,255,255,0.35)" />
    <!-- Mic stand / bracket -->
    <path id="voicelayer-mic-stand" d="M6 26 A14 14 0 0 0 34 26" fill="none"
          stroke="var(--vl-mic-stand-color)" stroke-width="2.4" stroke-linecap="round" />
    <line x1="20" y1="40" x2="20" y2="50" stroke="var(--vl-mic-stand-color)" stroke-width="2.4" stroke-linecap="round" />
    <line x1="11" y1="50" x2="29" y2="50" stroke="var(--vl-mic-stand-color)" stroke-width="2.4" stroke-linecap="round" />
  `;

  wrapper.appendChild(glow);
  wrapper.appendChild(leftSide);
  wrapper.appendChild(core);
  wrapper.appendChild(rightSide);

  micVisualWrapperEl = wrapper;
  micGlowEl = glow;
  waveBarEls.left = leftBarEls;
  waveBarEls.right = rightBarEls;

  return { wrapper, core };
}

function updateAmbientGlowForState(state) {
  if (!micGlowEl) {
    return;
  }
  if (state === "listening" || state === "speaking") {
    micGlowEl.classList.add("voicelayer-glow-active");
  } else {
    micGlowEl.classList.remove("voicelayer-glow-active");
  }
  // VISUAL: amber glow while "thinking" (processing) so it's clearly a
  // different state from idle grey / listening-speaking blue, instead of
  // relying on a CSS selector to reach across sibling elements.
  micGlowEl.style.setProperty("--vl-glow-color", state === "processing" ? "255, 171, 46" : "79, 158, 255");
}

// VISUAL: bar heights/opacity now map onto a subtler, less "bouncy" curve
// (smaller max height, gentler envelope) so the waveform reads like a
// real audio meter/EQ rather than a cartoon jumping bar. Same inputs
// (indexFromCenter, totalBars, level), same call sites — only the shaping
// math and CSS look changed.
function applyBarFrame(bar, indexFromCenter, totalBars, level) {
  const minHeight = 4;
  const maxHeight = 34;
  // Bars closer to the mic move more than the outer ones, and each bar
  // gets a slightly different phase so the motion reads as a fluid wave
  // instead of every bar bouncing in lockstep.
  const envelope = 1 - indexFromCenter / (totalBars + 1.6);
  const phase = waveTimePhase + indexFromCenter * 0.5;
  const wobble = 0.5 + 0.5 * Math.sin(phase);
  const amplitude = level * envelope;
  const height = minHeight + (maxHeight - minHeight) * amplitude * (0.6 + 0.4 * wobble);
  bar.style.height = height.toFixed(1) + "px";
  bar.style.opacity = (0.4 + 0.6 * amplitude).toFixed(2);
}

function renderWaveBars(level) {
  const clampedLevel = Math.max(0, Math.min(1, level));
  waveBarEls.left.forEach((bar, i) => applyBarFrame(bar, i, waveBarEls.left.length, clampedLevel));
  waveBarEls.right.forEach((bar, i) => applyBarFrame(bar, i, waveBarEls.right.length, clampedLevel));
}

// Single shared animation loop, started once when the overlay is first
// built. It's cheap enough to keep running for the life of the page; it
// only does real work while the overlay is visible.
function waveAnimationLoop() {
  waveTimePhase += 0.07;
  decayingSpeechActivity *= 0.88;

  const overlay = document.getElementById("voicelayer-overlay");
  const isOverlayVisible = overlay && overlay.style.display !== "none";

  if (isOverlayVisible) {
    let target = 0;

    if (currentMicState === "listening") {
      if (micVisAnalyser && micVisDataArray) {
        target = readAnalyserLevel(micVisAnalyser, micVisDataArray);
      } else {
        target = Math.min(1, decayingSpeechActivity);
      }
    } else if (currentMicState === "speaking") {
      if (speakerVisAnalyser && speakerVisDataArray) {
        target = readAnalyserLevel(speakerVisAnalyser, speakerVisDataArray);
      } else {
        target = 0.45 + 0.15 * Math.sin(waveTimePhase);
      }
    } else if (currentMicState === "processing") {
      target = 0.12 + 0.06 * Math.sin(waveTimePhase * 0.6);
    } else {
      target = 0;
    }

    currentWaveLevel += (target - currentWaveLevel) * 0.15;
    renderWaveBars(currentWaveLevel);
  }

  requestAnimationFrame(waveAnimationLoop);
}

// ---------------------------------------------------------------------------
// MESSAGE LISTENER
// Listens for messages sent from background.js (triggered by the keyboard
// shortcut). We only care about messages shaped like { action: "toggle" }.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.action === "toggle") {
    toggleOverlay();
  }
});

// ---------------------------------------------------------------------------
// OVERLAY CREATION / TOGGLING
// ---------------------------------------------------------------------------

// This function either creates the overlay (first time it's toggled on a page)
// or just shows/hides it (every time after that).
function toggleOverlay() {
  let overlay = document.getElementById("voicelayer-overlay");

  if (overlay) {
    // The overlay already exists, so just flip its visibility.
    const isHidden = overlay.style.display === "none";
    overlay.style.display = isHidden ? "block" : "none";

    // Start listening whenever we SHOW the overlay, and stop listening
    // whenever we HIDE it (no point using the mic if nothing is visible).
    if (isHidden) {
      startListening();
    } else {
      stopListening();
    }
  } else {
    // The overlay doesn't exist yet — build it from scratch.
    overlay = buildOverlay();
    document.body.appendChild(overlay);

    // PERF: Warm up the connection to the backend as soon as the overlay
    // exists, instead of waiting for the first real request to pay the
    // DNS/TCP/TLS handshake cost. This runs once per page load and doesn't
    // touch backend logic or the response the user sees — it just means
    // the *first* real POST to /api/process doesn't start a connection
    // from cold, shaving the handshake latency off the very first turn.
    warmUpBackendConnection();

    // As soon as the overlay is created, start listening for speech.
    startListening();
  }
}

// PERF: Opens (and immediately lets browser keep alive) a connection to the
// backend origin ahead of time, so the handshake is already done by the time
// the user finishes their first sentence. Uses a <link rel="preconnect">
// hint (the standard, zero-side-effect way to warm a connection) rather than
// hitting /api/process itself, so it can never trigger backend processing
// or affect the real request/response flow.
function warmUpBackendConnection() {
  if (document.getElementById("voicelayer-preconnect")) {
    return; // Already warmed up for this page.
  }
  try {
    const link = document.createElement("link");
    link.id = "voicelayer-preconnect";
    link.rel = "preconnect";
    link.href = BACKEND_ORIGIN;
    document.head.appendChild(link);
  } catch (error) {
    // Never let a warm-up failure affect the actual feature.
    console.error("VoiceLayer: preconnect warm-up failed (non-fatal):", error);
  }
}

// Builds the overlay <div> and all of its child elements (title, mic
// visual, transcript box, response box, close button), then returns it.
function buildOverlay() {
  // Make sure our CSS animations (mic gradients, glow, waves) are on the page.
  injectStyles();

  // --- Outer container ---------------------------------------------------
  const overlay = document.createElement("div");
  overlay.id = "voicelayer-overlay";

  // Inline styles so the overlay looks the same on every website,
  // regardless of that site's own CSS.
  overlay.style.position = "fixed";
  overlay.style.bottom = "20px";
  overlay.style.right = "20px";
  overlay.style.width = "320px";
  // VISUAL: very dark navy/near-black background, calmer/more "hardware
  // panel" feel to match the realistic mic glyph.
  overlay.style.background = "linear-gradient(180deg, #101114 0%, #17181c 100%)";
  overlay.style.borderRadius = "16px";
  overlay.style.padding = "16px";
  overlay.style.color = "white";
  overlay.style.zIndex = "999999";
  overlay.style.boxShadow = "0 8px 24px rgba(0,0,0,0.55)";
  overlay.style.fontFamily = "Arial, sans-serif";
  overlay.style.boxSizing = "border-box";

  // --- Close button (×) in the top-right corner ---------------------------
  const closeButton = document.createElement("button");
  closeButton.id = "voicelayer-close-btn";
  closeButton.innerText = "×";
  closeButton.style.position = "absolute";
  closeButton.style.top = "8px";
  closeButton.style.right = "12px";
  closeButton.style.background = "transparent";
  closeButton.style.border = "none";
  closeButton.style.color = "white";
  closeButton.style.fontSize = "20px";
  closeButton.style.cursor = "pointer";
  closeButton.style.lineHeight = "1";
  // Clicking the × hides the overlay and stops the microphone.
  closeButton.addEventListener("click", () => {
    overlay.style.display = "none";
    stopListening();
  });

  // Note: the overlay is already "position: fixed" (set above), which — just
  // like "relative" — establishes a positioning context for its children.
  // So the close button's "position: absolute" will correctly anchor to
  // this overlay div rather than the whole page. No extra wrapper needed.

  // --- History icon button (top-left corner) ------------------------------
  // Mirrors the close button's positioning on the opposite corner. Clicking
  // it slides the history panel (built below) open/closed.
  const historyButton = document.createElement("button");
  historyButton.id = "voicelayer-history-btn";
  historyButton.innerText = "🕘";
  historyButton.title = "History";
  historyButton.style.position = "absolute";
  historyButton.style.top = "8px";
  historyButton.style.left = "12px";
  historyButton.style.background = "transparent";
  historyButton.style.border = "none";
  historyButton.style.color = "white";
  historyButton.style.fontSize = "16px";
  historyButton.style.cursor = "pointer";
  historyButton.style.lineHeight = "1";
  historyButton.style.padding = "0";
  historyButton.addEventListener("click", () => {
    toggleHistoryPanel();
  });

  // --- Title ("Vani") -----------------------------------------------------
  // Small bold, centered title shown above the mic circle. Purely cosmetic
  // — added alongside the close/history buttons and doesn't participate in
  // any state logic.
  const titleDiv = document.createElement("div");
  titleDiv.id = "voicelayer-title";
  titleDiv.innerText = "Vani";
  titleDiv.style.textAlign = "center";
  titleDiv.style.fontWeight = "bold";
  titleDiv.style.fontSize = "15px";
  titleDiv.style.letterSpacing = "0.5px";
  titleDiv.style.color = "#c9a7ff"; // light purple/accent matching the theme
  titleDiv.style.marginTop = "2px";
  titleDiv.style.marginBottom = "4px";

  // --- History panel (slides open below the header, above the mic) -------
  // Collapsed by default via max-height/opacity, both transitioned so
  // opening/closing animates as a simple slide instead of an abrupt jump.
  const historyPanel = document.createElement("div");
  historyPanel.id = "voicelayer-history-panel";
  historyPanel.style.overflow = "hidden";
  historyPanel.style.maxHeight = "0px";
  historyPanel.style.opacity = "0";
  historyPanel.style.marginBottom = "0px";
  historyPanel.style.transition = "max-height 0.3s ease, opacity 0.3s ease, margin-bottom 0.3s ease";

  const historyList = document.createElement("div");
  historyList.id = "voicelayer-history-list";
  historyList.style.maxHeight = "300px";
  historyList.style.overflowY = "auto";
  historyPanel.appendChild(historyList);

  // --- Mic visual (realistic mic glyph + ambient glow + reactive wave bars) ---
  // VISUAL: replaces the old flat colored circle with a realistic
  // condenser-mic shape. The states it reflects are unchanged:
  //   idle       = calm/dim metal
  //   listening  = lit up, waves react to real mic volume
  //   processing = gentle breathing glow, calm waves
  //   speaking   = lit up, waves react to real AI audio output
  const micVisual = buildMicVisual();
  const micCircle = micVisual.core;
  setMicState(micCircle, "idle"); // Start out idle.

  // --- Transcript box (shows live speech-to-text as the user talks) ------
  const transcriptDiv = document.createElement("div");
  transcriptDiv.id = "voicelayer-transcript";
  transcriptDiv.innerText = "Vani is listening...";
  transcriptDiv.style.background = "rgba(255, 255, 255, 0.08)";
  transcriptDiv.style.borderRadius = "8px";
  transcriptDiv.style.padding = "10px";
  transcriptDiv.style.marginBottom = "10px";
  transcriptDiv.style.minHeight = "40px";
  transcriptDiv.style.fontSize = "14px";
  transcriptDiv.style.whiteSpace = "pre-wrap";

  // --- Response box (shows the AI's text response) -------------------------
  const responseDiv = document.createElement("div");
  responseDiv.id = "voicelayer-response";
  responseDiv.innerText = "";
  responseDiv.style.background = "rgba(255, 255, 255, 0.14)";
  responseDiv.style.borderRadius = "8px";
  responseDiv.style.padding = "10px";
  responseDiv.style.minHeight = "40px";
  responseDiv.style.fontSize = "14px";
  responseDiv.style.whiteSpace = "pre-wrap";

  // Put everything together inside the overlay.
  overlay.appendChild(closeButton);
  overlay.appendChild(historyButton);
  overlay.appendChild(titleDiv);
  overlay.appendChild(historyPanel);
  overlay.appendChild(micVisual.wrapper);
  overlay.appendChild(transcriptDiv);
  overlay.appendChild(responseDiv);

  // PERF: Cache these nodes once, here, at creation time. Every other
  // function below now reads from these module-level variables instead of
  // re-querying the DOM. This is safe because the overlay div is only ever
  // shown/hidden (display toggle), never removed and rebuilt, so these
  // references stay valid for the lifetime of the page.
  micCircleEl = micCircle;
  transcriptDivEl = transcriptDiv;
  responseDivEl = responseDiv;
  historyButtonEl = historyButton;
  historyPanelEl = historyPanel;
  historyListEl = historyList;

  // VISUAL: start the shared wave-animation loop once, here. It checks
  // overlay visibility and currentMicState on every frame, so it doesn't
  // need to be started/stopped anywhere else.
  requestAnimationFrame(waveAnimationLoop);

  return overlay;
}

// ---------------------------------------------------------------------------
// HISTORY PANEL
// ---------------------------------------------------------------------------

// Opens/closes the sliding history panel. Opening triggers a fresh fetch
// from the backend every time, so the user always sees up-to-date entries.
function toggleHistoryPanel() {
  if (isHistoryPanelOpen) {
    closeHistoryPanel();
  } else {
    openHistoryPanel();
  }
}

function openHistoryPanel() {
  isHistoryPanelOpen = true;
  if (historyPanelEl) {
    historyPanelEl.style.maxHeight = "320px";
    historyPanelEl.style.opacity = "1";
    historyPanelEl.style.marginBottom = "10px";
  }
  fetchAndRenderHistory();
}

function closeHistoryPanel() {
  isHistoryPanelOpen = false;
  if (historyPanelEl) {
    historyPanelEl.style.maxHeight = "0px";
    historyPanelEl.style.opacity = "0";
    historyPanelEl.style.marginBottom = "0px";
  }
}

// Fetches history entries from the backend and renders them as cards,
// newest first. Uses the same "ignore stale response" pattern as the main
// backend request: if the panel gets closed/reopened again before this
// fetch resolves, the older response is silently discarded.
function fetchAndRenderHistory() {
  if (!historyListEl) {
    return;
  }

  historyRequestId++;
  const thisHistoryRequestId = historyRequestId;

  historyListEl.innerText = "Loading history...";

  fetch(HISTORY_ENDPOINT)
    .then((response) => response.json())
    .then((data) => {
      if (thisHistoryRequestId !== historyRequestId) {
        return; // Panel was closed/reopened again — this result is stale.
      }
      const entries = Array.isArray(data) ? data : (data.entries || []);
      renderHistoryEntries(sortHistoryEntriesNewestFirst(entries));
    })
    .catch((error) => {
      if (thisHistoryRequestId !== historyRequestId) {
        return;
      }
      console.error("VoiceLayer: error fetching history:", error);
      historyListEl.innerText = "Could not load history.";
    });
}

// Sorts entries newest-first. If entries carry a recognizable timestamp
// field, sort by it; otherwise assume the backend returned them in
// insertion (oldest-first) order and simply reverse.
function sortHistoryEntriesNewestFirst(entries) {
  if (!entries.length) {
    return entries;
  }
  const timestampField = ["timestamp", "created_at", "time", "date"].find(
    (field) => entries[0][field] !== undefined
  );
  if (timestampField) {
    return entries.slice().sort((a, b) => new Date(b[timestampField]) - new Date(a[timestampField]));
  }
  return entries.slice().reverse();
}

// Renders the given entries into the history list container as small cards.
function renderHistoryEntries(entries) {
  if (!historyListEl) {
    return;
  }

  historyListEl.innerText = "";

  if (!entries.length) {
    historyListEl.innerText = "No history yet.";
    return;
  }

  entries.forEach((entry) => {
    historyListEl.appendChild(createHistoryEntryCard(entry));
  });
}

// Builds a single history entry card: an action badge, the user's text,
// and the response text.
function createHistoryEntryCard(entry) {
  const card = document.createElement("div");
  card.style.background = "rgba(255, 255, 255, 0.08)";
  card.style.borderRadius = "8px";
  card.style.padding = "8px 10px";
  card.style.marginBottom = "8px";
  card.style.fontSize = "13px";

  const badge = document.createElement("span");
  const action = entry.action || "unknown";
  badge.innerText = action;
  badge.style.display = "inline-block";
  badge.style.padding = "2px 8px";
  badge.style.borderRadius = "10px";
  badge.style.fontSize = "11px";
  badge.style.fontWeight = "bold";
  badge.style.textTransform = "capitalize";
  badge.style.color = "white";
  badge.style.background = HISTORY_ACTION_COLORS[action.toLowerCase()] || HISTORY_ACTION_DEFAULT_COLOR;
  badge.style.marginBottom = "6px";

  const userTextDiv = document.createElement("div");
  userTextDiv.innerText = entry.user_text || "";
  userTextDiv.style.marginTop = "6px";
  userTextDiv.style.color = "rgba(255, 255, 255, 0.9)";
  userTextDiv.style.whiteSpace = "pre-wrap";

  const responseTextDiv = document.createElement("div");
  responseTextDiv.innerText = entry.response_text || "";
  responseTextDiv.style.marginTop = "4px";
  responseTextDiv.style.color = "rgba(255, 255, 255, 0.65)";
  responseTextDiv.style.whiteSpace = "pre-wrap";

  card.appendChild(badge);
  card.appendChild(userTextDiv);
  card.appendChild(responseTextDiv);

  return card;
}

// Injects a <style> tag (once) into the page's <head>. Holds all the CSS
// that can't be expressed as inline styles: keyframe animations, and the
// per-state color variables for the realistic mic glyph.
function injectStyles() {
  if (document.getElementById("voicelayer-styles")) {
    return; // Already injected — don't add it twice.
  }

  const style = document.createElement("style");
  style.id = "voicelayer-styles";
  style.innerText = `
    /* VISUAL: soft pulse ring behind the mic while listening. Same class,
       same toggle logic, same timing mechanism as before — this is just a
       gentler shadow so it reads as "device is live" rather than a flashy
       animated cartoon halo. */
    @keyframes voicelayer-pulse {
      0%   { filter: drop-shadow(0 0 0px rgba(90, 200, 255, 0.5)); }
      70%  { filter: drop-shadow(0 0 9px rgba(90, 200, 255, 0.05)); }
      100% { filter: drop-shadow(0 0 0px rgba(90, 200, 255, 0)); }
    }
    #voicelayer-mic-circle.voicelayer-listening {
      animation: voicelayer-pulse 1.8s infinite;
    }

    @keyframes voicelayer-breathe {
      0%, 100% { opacity: 0.6; transform: translate(-50%, -50%) scale(1); }
      50%      { opacity: 0.95; transform: translate(-50%, -50%) scale(1.05); }
    }

    #voicelayer-mic-visual {
      position: relative;
      width: 100%;
      height: 92px;
      margin: 4px 0 18px 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }

    #voicelayer-mic-glow {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 74px;
      height: 74px;
      border-radius: 50%;
      transform: translate(-50%, -50%);
      background: radial-gradient(circle, rgba(var(--vl-glow-color, 79, 158, 255), 0.42) 0%, rgba(var(--vl-glow-color, 79, 158, 255), 0.18) 45%, rgba(0,0,0,0) 75%);
      filter: blur(6px);
      pointer-events: none;
      transition: opacity 0.4s ease, background 0.3s ease;
      opacity: 0.5;
      z-index: 0;
    }
    #voicelayer-mic-glow.voicelayer-glow-active {
      animation: voicelayer-breathe 2.4s ease-in-out infinite;
    }

    /* VISUAL: the mic core is now an SVG glyph (see buildMicVisual), sized
       and colored through these CSS variables + the classes below, instead
       of a flat background-color swap. Real metal/plastic tones per state,
       not a saturated cartoon gradient. */
    #voicelayer-mic-circle {
      position: relative;
      width: 34px;
      height: 54px;
      z-index: 2;
      flex-shrink: 0;
      overflow: visible;
      transition: filter 0.3s ease;
      --vl-mic-body-light: #6b7178;
      --vl-mic-body-mid: #494d54;
      --vl-mic-body-dark: #2b2d32;
      --vl-mic-stand-color: #55585e;
    }

    #voicelayer-mic-circle.voicelayer-state-idle {
      --vl-mic-body-light: #6d727a;
      --vl-mic-body-mid: #4a4e56;
      --vl-mic-body-dark: #2a2c31;
      --vl-mic-stand-color: #55585f;
    }
    #voicelayer-mic-circle.voicelayer-state-listening {
      --vl-mic-body-light: #cfe6ff;
      --vl-mic-body-mid: #4f9eff;
      --vl-mic-body-dark: #1c4d8c;
      --vl-mic-stand-color: #8ec1f2;
    }
    #voicelayer-mic-circle.voicelayer-state-processing {
      --vl-mic-body-light: #ffe3a3;
      --vl-mic-body-mid: #ffab2e;
      --vl-mic-body-dark: #8f5a0d;
      --vl-mic-stand-color: #f0be6e;
    }

    /* Default (listening/speaking) glow tint — blue. Processing overrides
       this inline via updateAmbientGlowForState() so it reads amber. */
    #voicelayer-mic-glow {
      --vl-glow-color: 79, 158, 255;
    }
    #voicelayer-mic-circle.voicelayer-state-speaking {
      --vl-mic-body-light: #c7ecff;
      --vl-mic-body-mid: #35bfff;
      --vl-mic-body-dark: #0d5f96;
      --vl-mic-stand-color: #86d4f5;
    }

    /* VISUAL: waveform bars restyled to look like a real level meter /
       studio EQ readout — brighter cyan-to-violet gradient with a soft
       glow on peak, instead of muted flat bars or a neon cartoon look. */
    .voicelayer-wave-side {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 3px;
      height: 46px;
    }
    .voicelayer-wave-bar {
      width: 3px;
      height: 4px;
      border-radius: 1.5px;
      opacity: 0.4;
      background: linear-gradient(180deg, #7fe0ff 0%, #4f9eff 60%, #7a6bff 100%);
      box-shadow: 0 0 5px rgba(79, 190, 255, 0.55);
      transition: background 0.3s ease;
    }
  `;
  document.head.appendChild(style);
}

// Tracks the mic circle's current state ("idle", "listening", "processing",
// or "speaking") so other parts of the code — like the watchdog and the
// wave-animation loop — can check what's going on without having to
// re-read styles off the DOM element.
let currentMicState = "idle";

// Updates the mic's look based on the current state. Valid states: "idle",
// "listening", "processing", "speaking". Called from exactly the same
// places as before, with exactly the same states — only what happens
// *inside* changed (SVG mic tone + glow instead of a flat color).
function setMicState(micCircle, state) {
  currentMicState = state; // Remember the latest state globally.

  // Remove the pulsing animation class by default; we'll re-add it if needed.
  micCircle.classList.remove("voicelayer-listening");

  // VISUAL: swap the mic-tone class for the new state.
  micCircle.classList.remove(
    "voicelayer-state-idle",
    "voicelayer-state-listening",
    "voicelayer-state-processing",
    "voicelayer-state-speaking"
  );
  micCircle.classList.add("voicelayer-state-" + state);

  if (state === "listening") {
    micCircle.classList.add("voicelayer-listening"); // turns on the pulse animation
  }

  // VISUAL: let the ambient glow react to the new state too.
  updateAmbientGlowForState(state);
}

// ---------------------------------------------------------------------------
// SPEECH RECOGNITION
// ---------------------------------------------------------------------------

// Calling recognition.start() when recognition is already running throws an
// "InvalidStateError". This can happen because recognition.stop() is
// asynchronous — the recognizer hasn't actually finished stopping yet, even
// though we've already called stop(). This helper wraps start() so that
// specific, harmless error is silently ignored, while any other unexpected
// error still gets logged so we notice real problems.
function safeStartRecognition() {
  if (!recognition) {
    return;
  }
  try {
    recognition.start();
  } catch (error) {
    if (error.name === "InvalidStateError") {
      // Recognition was already running — nothing to do, this is fine.
      return;
    }
    console.error("VoiceLayer: unexpected error starting recognition:", error);
  }
}

// Starts the browser's built-in speech recognition so we can turn the
// user's voice into text.
function startListening() {
  // Chrome exposes this as "webkitSpeechRecognition"; some browsers may
  // eventually support the plain "SpeechRecognition" name too.
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    updateTranscriptText("Speech recognition is not supported in this browser.");
    return;
  }

  // Reset any old transcript from a previous session.
  finalTranscript = "";

  // Also reset the watchdog's activity clock, so it doesn't immediately
  // think we're "stuck" right after (re)starting.
  lastActivityTime = Date.now();

  // VISUAL: (re)attempt the separate, visualization-only mic capture used
  // for real waveform reactivity while listening. Guarded internally so it
  // only actually prompts once per session; never touches recognition.
  initMicInputAnalyserOnce();

  recognition = new SpeechRecognition();
  recognition.continuous = true;     // Keep listening instead of stopping after one phrase.
  recognition.interimResults = true; // Give us "in-progress" results as the user talks.
  recognition.lang = "en-IN";        // English (India) — matches the user's expected accent.

  // Fires repeatedly while the user speaks, with both "interim" (still being
  // figured out) and "final" (confirmed) pieces of text.
  recognition.onresult = (event) => {
    // Mark that recognition is definitely still alive and producing
    // results — this is what the watchdog checks to detect a freeze.
    lastActivityTime = Date.now();

    // PERF: use the cached mic circle element instead of an
    // getElementById() lookup. onresult can fire many times per second
    // while the user is talking, so this avoids repeated DOM tree walks
    // on the hottest path in the whole file.
    const micCircle = micCircleEl;

    // ---- STEP 1 + 3 (merged): single pass over the new results ----------
    // The original code looped over event.results twice: once to "peek"
    // at the combined new text (to decide on an interruption), and again
    // to actually accumulate it into finalTranscript/interimTranscript.
    // That meant calling result[0].transcript twice per index on every
    // single onresult event. Here we walk the new results exactly once,
    // caching each result's text/isFinal, so both the interruption check
    // and the accumulation step reuse the same cached values instead of
    // touching the SpeechRecognitionResultList twice.
    let newSpeechPeek = "";
    const newResults = [];
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript;
      newResults.push({ text, isFinal: result.isFinal });
      newSpeechPeek += text;
    }

    // VISUAL: bump the fallback "speech activity" proxy used by the wave
    // animation when the real mic-volume analyser isn't available. Purely
    // additive — doesn't affect any of the logic below.
    decayingSpeechActivity = Math.min(1, decayingSpeechActivity + newSpeechPeek.trim().length * 0.04);

    // ---- STEP 2: check whether we should treat this as an interruption ----
    // We're "busy" if audio is currently playing OR a backend request is
    // still in flight. If the user says something meaningful (not just a
    // short noise blip) while we're busy, cancel whatever's in progress
    // and start listening fresh.
    const isBusy = currentAudio !== null || currentAbortController !== null;
    const isMeaningfulSpeech = newSpeechPeek.trim().length >= MIN_INTERRUPT_CHARS;

    if (isBusy && isMeaningfulSpeech) {
      console.log("Interruption detected - cancelling previous response");

      // Stop any audio that's currently playing.
      if (currentAudio) {
        console.log("Interruption detected - pausing current audio playback");
        currentAudio.pause();
        currentAudio = null;
        // PERF: release the Blob URL backing the interrupted audio clip
        // right away instead of waiting for onended/onerror (which will
        // never fire now that we've paused and dropped the reference).
        if (currentAudioObjectUrl) {
          URL.revokeObjectURL(currentAudioObjectUrl);
          currentAudioObjectUrl = null;
        }
        // VISUAL: the speaker-output analyser was tied to that now-paused
        // audio element — drop it so the wave loop falls back cleanly.
        teardownSpeakerVisualizer();
      }

      // Cancel any backend request that's still waiting for a reply.
      if (currentAbortController) {
        console.log("Interruption detected - aborting in-flight backend request");
        currentAbortController.abort();
        currentAbortController = null;
      }

      // Bump the request ID so that if the old (cancelled) request's
      // response arrives late anyway, we know to ignore it.
      currentRequestId++;

      // Wipe the transcript completely — the user is starting a brand
      // new command, so we don't want any leftover text from before.
      finalTranscript = "";
      updateTranscriptText("");

      // Immediately reflect that we're back to normal listening mode.
      if (micCircle) setMicState(micCircle, "listening");
    }

    // ---- STEP 3: normal transcript accumulation (unchanged logic) --------
    // This runs every time, whether or not an interruption just happened.
    // If we just cleared the transcript above, this naturally starts
    // building a fresh one from this event's speech. We now iterate over
    // the small `newResults` array we already built above instead of
    // re-reading event.results.
    let interimTranscript = "";
    let receivedFinalResult = false; // Tracks whether THIS event contained a final result.

    for (let i = 0; i < newResults.length; i++) {
      const { text, isFinal } = newResults[i];
      if (isFinal) {
        // This chunk of speech is "locked in" — add it to our running transcript.
        finalTranscript += text + " ";
        receivedFinalResult = true;
      } else {
        // This chunk is still being recognized and may change — show it live.
        interimTranscript += text;
      }
    }

    // Show the user everything we have so far: confirmed text + live-in-progress text.
    // (This still happens on every event, interim or final, so the live
    // transcript display keeps updating as before.)
    updateTranscriptText(finalTranscript + interimTranscript);

    // The user is actively speaking, so make sure the mic circle shows "listening".
    if (micCircle) setMicState(micCircle, "listening");

    // Only reset the "silence timer" when we got a FINAL result in this
    // event. Interim results fire very frequently (sometimes almost
    // continuously) while the user is mid-sentence, which was resetting
    // the timer over and over and never letting it complete. Final
    // results are much less frequent — they show up once a chunk of
    // speech is "locked in" — so this makes the timer actually count down
    // to SILENCE_DELAY_MS once real speech has stopped.
    if (receivedFinalResult) {
      resetSilenceTimer();
    }
  };

  // Fires if something goes wrong (e.g. mic permission denied).
  recognition.onerror = (event) => {
    // "no-speech" (and "aborted") fire routinely during normal use — e.g.
    // whenever the user's just quiet for a bit — and recognition.onend
    // already auto-restarts things right after. They're expected/harmless,
    // so we log them quietly instead of as console.error, which is what
    // was causing them to show up as "errors" on chrome://extensions.
    // Anything else is unexpected and still logged as a real error.
    if (event.error === "no-speech" || event.error === "aborted") {
      console.log("VoiceLayer speech recognition notice:", event.error);
      return;
    }
    console.error("VoiceLayer speech recognition error:", event.error);
  };

  // Some browsers automatically stop recognition after a period of silence
  // even with continuous = true. If that happens, restart it automatically
  // so listening feels seamless.
  recognition.onend = () => {
    const overlay = document.getElementById("voicelayer-overlay");
    const isOverlayVisible = overlay && overlay.style.display !== "none";
    if (isOverlayVisible) {
      console.log("Recognition ended, restarting");
      safeStartRecognition();
    }
  };

  safeStartRecognition();

  // Start the watchdog: every WATCHDOG_CHECK_MS, check whether recognition
  // seems to have silently frozen, and force-restart it if so. (If a
  // watchdog is already running from before, clear it first so we don't
  // end up with two running at once.)
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
  }
  watchdogInterval = setInterval(() => {
    const overlay = document.getElementById("voicelayer-overlay");
    const isOverlayVisible = overlay && overlay.style.display !== "none";
    const timeSinceLastActivity = Date.now() - lastActivityTime;
    const isStuck = timeSinceLastActivity > WATCHDOG_STUCK_THRESHOLD_MS;
    const isAudioPlaying = currentAudio !== null;
    const isRequestInProgress = currentAbortController !== null;

    // If the mic is idle, the user simply isn't in the middle of talking,
    // waiting on a response, or hearing one played back — that's normal,
    // expected silence, not a stuck recognizer. Only treat "no activity"
    // as suspicious while we're actively in a listening/processing/speaking
    // cycle.
    const isActivelyInACycle = currentMicState !== "idle";

    // Make sure enough time has passed since our last forced restart. If
    // the watchdog restarted things a moment ago, don't let it immediately
    // decide something is stuck again before things have had a chance to
    // settle — that's what was causing the restart loop.
    const timeSinceLastRestart = Date.now() - lastWatchdogRestart;
    const cooldownHasPassed = timeSinceLastRestart > WATCHDOG_RESTART_COOLDOWN_MS;

    // Only force-restart if: the overlay is visible, we've genuinely seen
    // no activity for a while, we're actually in the middle of a listening/
    // processing/speaking cycle (not just normal idle silence), we're not
    // just quiet because audio is playing or a backend request is in
    // progress, and we haven't restarted too recently.
    if (
      isOverlayVisible &&
      isStuck &&
      isActivelyInACycle &&
      !isAudioPlaying &&
      !isRequestInProgress &&
      cooldownHasPassed
    ) {
      console.log("Watchdog: recognition seemed stuck, restarting");
      if (recognition) {
        // Only call stop() here — stop() is asynchronous, so calling
        // start() immediately afterward throws "InvalidStateError"
        // because the recognizer hasn't actually finished stopping yet.
        // Instead, we rely on the existing recognition.onend handler
        // above, which automatically calls safeStartRecognition() once
        // the recognizer has genuinely finished shutting down.
        recognition.stop();
      }
      // Record when this restart happened, so the cooldown check above
      // can prevent another restart from firing too soon after this one.
      lastWatchdogRestart = Date.now();
      // Reset the clock so we don't fire again immediately while we
      // wait for the stop -> onend -> restart sequence to complete.
      lastActivityTime = Date.now();
    }
  }, WATCHDOG_CHECK_MS);
}

// Stops speech recognition completely (used when the overlay is closed/hidden).
function stopListening() {
  if (recognition) {
    // Prevent onend from auto-restarting recognition when we're
    // intentionally stopping it.
    recognition.onend = null;
    recognition.stop();
    recognition = null;
  }
  clearTimeout(silenceTimer);

  // Stop the watchdog too — there's no point checking for a "stuck"
  // recognizer when we've intentionally turned recognition off, and
  // leaving the interval running would leak it for as long as the page
  // stays open.
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }

  // Also stop any audio that's still playing and cancel any pending
  // request, so nothing keeps running silently after the overlay closes.
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
    // PERF: release the Blob URL for whatever audio was mid-playback.
    if (currentAudioObjectUrl) {
      URL.revokeObjectURL(currentAudioObjectUrl);
      currentAudioObjectUrl = null;
    }
  }
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  currentRequestId++;

  // VISUAL: release the visualization-only mic stream/audio context now
  // that we're done listening, so the mic indicator in the browser tab
  // doesn't stay on and the AudioContext doesn't linger.
  teardownMicInputAnalyser();
  teardownSpeakerVisualizer();
}

// Updates the transcript <div> with the given text.
function updateTranscriptText(text) {
  // PERF: use the cached reference instead of getElementById(). This is
  // called on every onresult event.
  const transcriptDiv = transcriptDivEl;
  if (transcriptDiv) {
    transcriptDiv.innerText = text || "Vani is listening...";
  }
}

// Resets the "silence timer". Every time the user speaks, we cancel the old
// timer and start a fresh one. If SILENCE_DELAY_MS passes with no new
// speech, we treat that as "the user has finished talking" and send the
// transcript to the backend.
function resetSilenceTimer() {
  console.log("Silence timer reset");
  clearTimeout(silenceTimer);
  silenceTimer = setTimeout(() => {
    const textToSend = finalTranscript.trim();
    if (textToSend.length > 0) {
      console.log("Silence timer fired, sending: " + textToSend);
      sendTranscriptToBackend(textToSend);
      finalTranscript = ""; // Clear it out so the next sentence starts fresh.
    }
  }, SILENCE_DELAY_MS);
}

// ---------------------------------------------------------------------------
// BACKEND COMMUNICATION
// ---------------------------------------------------------------------------

// Sends the finished transcript to the local backend for processing, then
// handles the AI's text + audio response.
//
// NOTE: speech recognition is NEVER stopped or paused here. It keeps
// running the whole time this request is in flight (and later, while the
// response audio plays), so the user can interrupt at any point just by
// talking again.
function sendTranscriptToBackend(transcript) {
  console.log("Sending to backend: " + transcript);
  // PERF: cached references instead of getElementById().
  const micCircle = micCircleEl;
  const responseDiv = responseDivEl;

  // While we wait for a reply, show the "processing" (yellow) mic state.
  if (micCircle) setMicState(micCircle, "processing");
  if (responseDiv) responseDiv.innerText = "Thinking...";

  // Create a fresh AbortController for THIS request. If the user
  // interrupts before we get a response, onresult() will call
  // currentAbortController.abort() to cancel this fetch early.
  const abortController = new AbortController();
  currentAbortController = abortController;

  // Snapshot the current request ID. If a newer request starts (because
  // the user interrupted) before this one's response comes back, this
  // saved value will no longer match the live "currentRequestId" — that's
  // how we recognize a stale, no-longer-wanted response.
  const thisRequestId = currentRequestId;

  fetch(BACKEND_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ text: transcript }),
    signal: abortController.signal
  })
    .then((response) => response.json())
    .then((data) => {
      // If the user interrupted while we were waiting, currentRequestId
      // will have moved on. In that case, silently throw this away —
      // it belongs to a command the user already replaced.
      if (thisRequestId !== currentRequestId) {
        console.log("Discarding stale backend response - a newer request has since started");
        return;
      }

      // This response is still relevant — clear the abort controller
      // (there's nothing left to cancel) and show the result normally.
      currentAbortController = null;
      // Expected shape: { spoken_response: "...", audio_base64: "..." }
      handleBackendResponse(data);
    })
    .catch((error) => {
      // When we call abortController.abort(), the fetch promise rejects
      // with an "AbortError". That's expected during an interruption, not
      // a real problem — so we just log it and stop, without touching the UI.
      if (error.name === "AbortError") {
        console.log("Fetch request was aborted due to an interruption");
        return;
      }

      // A genuinely stale (but not aborted) error is also safe to ignore.
      if (thisRequestId !== currentRequestId) {
        return;
      }

      currentAbortController = null;
      console.error("VoiceLayer: error contacting backend:", error);
      if (responseDiv) responseDiv.innerText = "Error: could not reach VoiceLayer backend.";
      if (micCircle) setMicState(micCircle, "idle");
    });
}

// PERF: Decodes a base64 audio payload into a Blob URL instead of using it
// as a giant inline data: URI on the <audio> element. Two concrete wins:
//   1. A data: URI forces the browser to hold the full (~33% larger than
//      binary) base64 string as the element's `src` attribute and re-parse/
//      decode it inline on the main thread before playback can begin. A
//      Blob is decoded once, up front, into real binary bytes, and handed
//      to the media pipeline by reference (an opaque blob: URL), which
//      starts decoding/playback sooner for larger clips.
//   2. Blob URLs can be explicitly revoked (see the revoke calls added at
//      each place audio finishes/errors/gets interrupted below), instead of
//      leaving a large base64 string retained on the DOM element and in
//      memory for the life of the page.
// Output audio is byte-for-byte identical either way — this only changes
// *how* the same bytes get to the <audio> element, not what gets played.
function base64AudioToObjectUrl(base64, mimeType) {
  const byteChars = atob(base64);
  const byteNumbers = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  const blob = new Blob([byteNumbers], { type: mimeType });
  return URL.createObjectURL(blob);
}

// Handles the JSON response from the backend: shows the text and plays the audio.
function handleBackendResponse(data) {
  // PERF: cached references instead of getElementById().
  const micCircle = micCircleEl;
  const responseDiv = responseDivEl;

  if (responseDiv) {
    responseDiv.innerText = data.spoken_response || "(no response text)";
  }

  // If there's no audio to play, just go back to idle right away.
  if (!data.audio_base64) {
    if (micCircle) setMicState(micCircle, "idle");
    return;
  }

  // PERF: build a Blob URL instead of a "data:audio/mp3;base64,..." string
  // (see base64AudioToObjectUrl for why). Playback behavior is identical.
  const objectUrl = base64AudioToObjectUrl(data.audio_base64, "audio/mp3");
  const audio = new Audio(objectUrl);

  // VISUAL: hook up the reactive waveform to this turn's actual audio
  // output. This only taps the signal for visualization — see
  // setupSpeakerVisualizer() for why playback itself is unaffected.
  setupSpeakerVisualizer(audio);

  // Track this as "the audio currently playing". While this is set,
  // onresult() knows the AI is speaking and will treat new speech from
  // the user as an interruption instead of a normal command.
  currentAudio = audio;
  currentAudioObjectUrl = objectUrl; // PERF: remembered so we can revoke it later.

  // While the audio plays, show the "speaking" (blue) mic state.
  if (micCircle) setMicState(micCircle, "speaking");

  // Once the audio finishes playing, go back to idle so listening
  // continues to feel natural for the next thing the user says.
  audio.onended = () => {
    // Only clear currentAudio if it's still THIS audio (an interruption
    // may have already replaced it with null or a newer clip).
    if (currentAudio === audio) {
      currentAudio = null;
      // PERF: free the Blob URL now that playback has finished normally.
      URL.revokeObjectURL(objectUrl);
      if (currentAudioObjectUrl === objectUrl) {
        currentAudioObjectUrl = null;
      }
      // VISUAL: this turn's speaker analyser is no longer relevant.
      teardownSpeakerVisualizer();
    }
    if (micCircle) setMicState(micCircle, "idle");
  };

  // If playback fails for some reason, don't leave the mic stuck on blue.
  audio.onerror = () => {
    console.error("VoiceLayer: error playing response audio.");
    if (currentAudio === audio) {
      currentAudio = null;
      // PERF: free the Blob URL on the error path too, so a failed clip
      // doesn't leak memory for the rest of the page's life.
      URL.revokeObjectURL(objectUrl);
      if (currentAudioObjectUrl === objectUrl) {
        currentAudioObjectUrl = null;
      }
      // VISUAL: tear down here too, for the same reason as onended.
      teardownSpeakerVisualizer();
    }
    if (micCircle) setMicState(micCircle, "idle");
  };

  audio.play();
}