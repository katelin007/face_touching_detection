// ====================================================================
//  Face-Touch Alarm
//  Everything runs in the browser — no server, no data leaves the page.
//
//  Flow:  Start  ->  load models  ->  open camera  ->  open floating
//         window  ->  run detection loop  ->  buzz while hand is on face.
//
//  The detection loop is driven by the FLOATING window's animation
//  frames. That window stays visible, so the loop keeps running even
//  when your main tab is in the background.
// ====================================================================

import {
  FilesetResolver,
  HandLandmarker,
  FaceDetector,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10/vision_bundle.mjs";

// ---- Tunable settings ---------------------------------------------
// Change these if detection feels too twitchy or not sensitive enough.
const FACE_PADDING     = 0.15;   // grow the face box 15% so cheeks/chin/hair count as "face"
const RELEASE_DELAY_MS = 200;    // keep buzzing this long after the hand leaves (stops flicker)
const BUZZ_FREQUENCY   = 200;    // Hz — lower is a harsher buzz
const BUZZ_VOLUME      = 0.15;   // 0 = silent, 1 = loud

// ---- Page elements ------------------------------------------------
const primaryBtn = document.getElementById("primaryBtn");
const reopenBtn  = document.getElementById("reopenBtn");
const statusEl   = document.getElementById("status");
const stage    = document.getElementById("stage");    // the movable video container
const video    = document.getElementById("video");
const canvas   = document.getElementById("overlay");
const readout  = document.getElementById("readout");
const ctx      = canvas.getContext("2d");

// ---- Runtime state ------------------------------------------------
let handLandmarker, faceDetector;
let running       = false;
let lastVideoTime = -1;
let lastTouchTime = 0;
let pipWindow     = null;   // the floating window, or null when not open

// ====================================================================
//  1. Buzzer  (Web Audio — audio is NOT throttled in background tabs)
// ====================================================================
let audioCtx, gainNode;

function initAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = audioCtx.createOscillator();
  gainNode  = audioCtx.createGain();

  osc.type = "square";
  osc.frequency.value = BUZZ_FREQUENCY;
  gainNode.gain.value = 0;                    // start silent
  osc.connect(gainNode).connect(audioCtx.destination);
  osc.start();                                // runs forever; we just change volume
}

function buzz(on) {
  if (!gainNode) return;
  const target = on ? BUZZ_VOLUME : 0;
  gainNode.gain.setTargetAtTime(target, audioCtx.currentTime, 0.01);
}

// ====================================================================
//  2. Load the two MediaPipe models (hands + face)
// ====================================================================
async function loadModels() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10/wasm"
  );

  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 2,
  });

  faceDetector = await FaceDetector.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
  });
}

// ====================================================================
//  3. Camera
// ====================================================================
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
}

function stopCamera() {
  const stream = video.srcObject;
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());  // turns the camera light off
  video.srcObject = null;
}

// ====================================================================
//  4. The core question: is any hand point inside the face box?
// ====================================================================
function isHandOnFace(faces, hands) {
  if (!faces.length || !hands.length) return false;

  const w = video.videoWidth;
  const h = video.videoHeight;

  // Padded face boxes, in pixels.
  const boxes = faces.map((d) => {
    const b = d.boundingBox;                 // originX, originY, width, height (pixels)
    const px = b.width  * FACE_PADDING;
    const py = b.height * FACE_PADDING;
    return {
      x1: b.originX - px,
      y1: b.originY - py,
      x2: b.originX + b.width  + px,
      y2: b.originY + b.height + py,
    };
  });

  // Hand landmarks are normalised (0..1), so scale to pixels.
  for (const hand of hands) {
    for (const lm of hand) {
      const x = lm.x * w;
      const y = lm.y * h;
      for (const box of boxes) {
        if (x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2) return true;
      }
    }
  }
  return false;
}

// ====================================================================
//  5. Draw the video + boxes into the canvas overlay
// ====================================================================
function draw(faces, hands, touching) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.lineWidth   = 3;
  ctx.strokeStyle = touching ? "#ff3b30" : "#34c759";
  faces.forEach((d) => {
    const b = d.boundingBox;
    ctx.strokeRect(b.originX, b.originY, b.width, b.height);
  });

  ctx.fillStyle = "#0a84ff";
  hands.forEach((hand) => {
    hand.forEach((lm) => {
      ctx.beginPath();
      ctx.arc(lm.x * canvas.width, lm.y * canvas.height, 4, 0, Math.PI * 2);
      ctx.fill();
    });
  });
}

function setReadout(touching) {
  readout.textContent = touching ? "HAND ON FACE" : "CLEAR";
  readout.className   = "readout " + (touching ? "touching" : "clear");
}

// ====================================================================
//  6. Main loop
//     Uses the floating window's requestAnimationFrame when it's open,
//     so the loop survives the main tab being backgrounded.
// ====================================================================
function loop() {
  if (!running) return;
  const frameHost = pipWindow || window;

  // Only run detection when there's a fresh camera frame.
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const now = performance.now();

    const faces = faceDetector.detectForVideo(video, now).detections || [];
    const hands = handLandmarker.detectForVideo(video, now).landmarks || [];

    if (isHandOnFace(faces, hands)) lastTouchTime = now;
    const touching = now - lastTouchTime <= RELEASE_DELAY_MS;

    buzz(touching);
    setReadout(touching);
    draw(faces, hands, touching);
  }

  frameHost.requestAnimationFrame(loop);
}

// ====================================================================
//  7. Floating window (Document Picture-in-Picture)
// ====================================================================
async function openFloatingWindow() {
  if (!("documentPictureInPicture" in window)) {
    statusEl.textContent =
      "This browser has no Picture-in-Picture support, so detection will pause " +
      "when you leave this tab. Use Chrome or Edge on a PC for background alerts.";
    return;
  }

  pipWindow = await documentPictureInPicture.requestWindow({ width: 360, height: 480 });

  // Copy our stylesheet into the floating window.
  document
    .querySelectorAll('link[rel="stylesheet"], style')
    .forEach((node) => pipWindow.document.head.appendChild(node.cloneNode(true)));
  pipWindow.document.body.classList.add("pip");

  // Move the live view into the floating window (it plays once the camera starts).
  pipWindow.document.body.append(stage);
  if (video.srcObject) await video.play();

  pipWindow.addEventListener("pagehide", onFloatingClosed);
}

// Runs whenever the floating window closes (user-closed or via Stop).
// Brings the live view back onto the page.
function onFloatingClosed() {
  document.getElementById("main").append(stage);
  pipWindow = null;
  updateButtons();
  if (running) {
    statusEl.textContent =
      "Floating window closed — detection pauses when this tab is hidden. " +
      "Reopen it to keep alerts running in the background.";
  }
}

// Close the floating window ourselves (used by Stop).
function closeFloatingWindow() {
  if (pipWindow) pipWindow.close();   // triggers onFloatingClosed via pagehide
}

// ====================================================================
//  8. Start / stop / reopen
//     The first click is required for camera + audio permission.
//     Models and the audio context are set up once and then reused,
//     so stopping and starting again is instant.
// ====================================================================
async function startWatching() {
  primaryBtn.disabled = true;
  try {
    // Open the floating window FIRST, while your click still counts as
    // "user activation." Loading the models/camera before this would use
    // up that activation and the browser would refuse the window.
    if (!audioCtx) initAudio();
    await openFloatingWindow();

    if (!handLandmarker) {
      statusEl.textContent = "Loading models…";
      await loadModels();
    }
    statusEl.textContent = "Starting camera…";
    await startCamera();
    lastVideoTime = -1;

    running = true;
    updateButtons();
    if (pipWindow) {
      statusEl.textContent = "Watching. Keep the floating window visible in a corner.";
    } else if (!("documentPictureInPicture" in window)) {
      statusEl.textContent =
        "Watching in this tab. No floating-window support here, so detection " +
        "pauses if you switch away.";
    } else {
      statusEl.textContent = "Watching in this tab.";
    }
    loop();
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Couldn't start: " + err.message;
    running = false;
    updateButtons();
  }
}

function stopWatching() {
  running = false;
  buzz(false);              // silence the buzzer
  closeFloatingWindow();    // bring the view back to the page
  stopCamera();             // release the camera
  updateButtons();
  statusEl.textContent = "Stopped.";
}

async function reopenFloatingWindow() {
  reopenBtn.disabled = true;
  await openFloatingWindow();
  updateButtons();
  if (pipWindow) {
    statusEl.textContent = "Watching. Keep the floating window visible in a corner.";
  }
}

// Primary button reads "Stop" while running, "Start watching" otherwise.
// The reopen button appears only while running with no floating window.
function updateButtons() {
  primaryBtn.textContent = running ? "Stop" : "Start watching";
  primaryBtn.disabled = false;

  const canFloat = "documentPictureInPicture" in window;
  reopenBtn.hidden   = !(running && !pipWindow && canFloat);
  reopenBtn.disabled = false;
}

primaryBtn.addEventListener("click", () => {
  if (running) stopWatching();
  else startWatching();
});
reopenBtn.addEventListener("click", reopenFloatingWindow);
