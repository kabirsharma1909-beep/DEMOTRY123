/**
 * FreeHand – multimodal accessibility platform.
 *
 * Architecture:
 *  - Single shared MediaPipe model instance per mode (hand / face)
 *  - OneEuroFilter for cursor smoothing
 *  - GestureStateMachine + ClickStateMachine + ScrollStateMachine for reliable gesture → action
 *  - DwellEngine for optional dwell-to-click
 *  - Persistent settings via localStorage
 *  - Single camera stream via CameraManager singleton
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { FilesetResolver, GestureRecognizer, FaceLandmarker } from '@mediapipe/tasks-vision';
import { createRoot } from 'react-dom/client';

import { OneEuroFilter2D } from './lib/filters';
import { resolveGesture, GestureStateMachine, ClickStateMachine, ScrollStateMachine, type GestureName } from './lib/gesture';
import { DwellEngine, type DwellState } from './lib/dwell';
import { loadSettings, saveSettings, type AppSettings } from './lib/settings';
import { CameraManager } from './lib/camera';
import './styles.css';

// ─── MediaPipe URLs ────────────────────────────────────────────────────────────
const MP_WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm';
const HAND_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const FACE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// ─── Browser Action Types ──────────────────────────────────────────────────────
type BrowserAction =
  | { type: 'search'; query: string }
  | { type: 'youtube-search'; query: string }
  | { type: 'open-tab' }
  | { type: 'close-tab' }
  | { type: 'type'; text: string; pressEnter?: boolean }
  | { type: 'write'; text: string; pressEnter?: boolean }
  | { type: 'key'; key: string }
  | { type: 'scroll'; direction: 'up' | 'down' }
  | { type: 'pointer-move'; x: number; y: number }
  | { type: 'click'; x?: number; y?: number }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'open-result'; resultIndex: number }
  | { type: 'pause' };

// ─── Speech Recognition Types ──────────────────────────────────────────────────
interface BrowserSpeechRecognition extends EventTarget {
  lang: string; interimResults: boolean; continuous: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onresult: ((e: { results: { length: number; [i: number]: { [i: number]: { transcript: string } } } }) => void) | null;
  start(): void; stop(): void;
}
interface SpeechConstructor { new(): BrowserSpeechRecognition; }

// ─── Nav Sections ──────────────────────────────────────────────────────────────
type Section = 'home' | 'hand' | 'head' | 'voice' | 'filters' | 'sign-lab' | 'settings';

const NAV_ITEMS: { id: Section; label: string; icon: string }[] = [
  { id: 'home', label: 'Overview', icon: '⌂' },
  { id: 'hand', label: 'Hand Tracking', icon: '✋' },
  { id: 'head', label: 'Head Tracking', icon: '👁' },
  { id: 'voice', label: 'Voice Control', icon: '🎙' },
  { id: 'filters', label: 'Camera Filters', icon: '✦' },
  { id: 'sign-lab', label: 'Sign Lab', icon: '◈' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

// ─── Camera Filters ────────────────────────────────────────────────────────────
const FILTERS = [
  { id: 'none', label: 'Original', desc: 'Unaltered camera feed' },
  { id: 'landmarks', label: 'Landmarks', desc: 'Face landmark visualization' },
  { id: 'outline', label: 'Face Outline', desc: 'Facial contour overlay' },
  { id: 'glasses', label: 'Glasses', desc: 'Virtual glasses aligned to eyes' },
  { id: 'ears', label: 'Animal Ears', desc: 'Ear overlay on top of head' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helper: send action to local service
// ─────────────────────────────────────────────────────────────────────────────
async function postAction(action: BrowserAction, silent = false): Promise<string> {
  try {
    const res = await fetch('/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    });
    const data = (await res.json()) as { message?: string; error?: string };
    return data.message ?? data.error ?? 'OK';
  } catch {
    if (!silent) return 'Could not reach the local browser service.';
    return '';
  }
}

async function postCommand(command: string): Promise<string> {
  try {
    const res = await fetch('/api/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    const data = (await res.json()) as { message?: string; error?: string };
    return data.message ?? data.error ?? 'OK';
  } catch {
    return 'Could not reach the local browser service. Is `npm run dev` still running?';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DwellProgressRing — SVG circular progress indicator
// ─────────────────────────────────────────────────────────────────────────────
function DwellRing({ progress }: { progress: number }) {
  const r = 20;
  const circ = 2 * Math.PI * r;
  const dash = circ * (1 - progress);
  return (
    <svg width="52" height="52" viewBox="0 0 52 52" className="dwell-ring" aria-hidden>
      <circle cx="26" cy="26" r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="4" />
      <circle
        cx="26" cy="26" r={r} fill="none"
        stroke={progress > 0.8 ? '#34d399' : '#6366f1'}
        strokeWidth="4"
        strokeDasharray={circ}
        strokeDashoffset={dash}
        strokeLinecap="round"
        style={{ transform: 'rotate(-90deg)', transformOrigin: '26px 26px', transition: 'stroke-dashoffset 0.05s linear' }}
      />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────────────────────────────────────
function App() {
  // ── Settings ──────────────────────────────────────────────────────────────
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  function updateSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      saveSettings(next);
      return next;
    });
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  const [section, setSection] = useState<Section>('home');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // ── Camera & Tracking State ───────────────────────────────────────────────
  const [cameraState, setCameraState] = useState<'off' | 'starting' | 'ready' | 'error'>('off');
  const [handGesture, setHandGesture] = useState<GestureName>('No hand');
  const [clickCharge, setClickCharge] = useState(0);
  const [dwellState, setDwellState] = useState<DwellState>({ phase: 'idle', progress: 0, targetKey: null });
  const [handConfidence, setHandConfidence] = useState(0);

  // ── Head tracking ─────────────────────────────────────────────────────────
  const [headTracking, setHeadTracking] = useState(false);
  const [faceDetected, setFaceDetected] = useState(false);
  const headNeutralRef = useRef<{ x: number; y: number } | null>(null);

  // ── Voice ─────────────────────────────────────────────────────────────────
  const [listening, setListening] = useState(false);
  const [voiceCommand, setVoiceCommand] = useState('');
  const [typedCommand, setTypedCommand] = useState('');
  const [lastAction, setLastAction] = useState('No action yet.');
  const [actionTimestamp, setActionTimestamp] = useState('');

  // ── Filter ────────────────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ── Refs (do not trigger re-render) ──────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement>(null);
  const handLandmarkerRef = useRef<GestureRecognizer | null>(null);
  const faceLandmarkerRef = useRef<FaceLandmarker | null>(null);
  const animRef = useRef<number | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const autoListenRef = useRef(false);
  const lastPointerSendMs = useRef(0);

  // Engine instances (stable across renders)
  const cursorFilter = useRef(new OneEuroFilter2D({ minCutoff: settings.cursorSmoothing, beta: settings.cursorBeta }));
  const headCursorFilter = useRef(new OneEuroFilter2D({ minCutoff: 1.2, beta: 0.01 }));
  const gestureStateMachine = useRef(new GestureStateMachine());
  const clickSM = useRef(new ClickStateMachine(settings.gestureClickMs, 500));
  const scrollSM = useRef(new ScrollStateMachine());
  const dwellEngine = useRef(new DwellEngine(settings.dwellMs, 1000, settings.dwellStabilityPx / 1000));

  // Update engines when settings change
  useEffect(() => {
    cursorFilter.current = new OneEuroFilter2D({ minCutoff: settings.cursorSmoothing, beta: settings.cursorBeta });
    clickSM.current.reset(settings.gestureClickMs, 500);
    dwellEngine.current.configure(settings.dwellMs, 1000, settings.dwellStabilityPx / 1000);
  }, [settings.cursorSmoothing, settings.cursorBeta, settings.gestureClickMs, settings.dwellMs, settings.dwellStabilityPx]);

  // ── Report action ──────────────────────────────────────────────────────────
  const reportAction = useCallback((msg: string) => {
    setLastAction(msg);
    setActionTimestamp(new Date().toLocaleTimeString());
  }, []);

  // ── Send browser action ────────────────────────────────────────────────────
  const sendAction = useCallback(async (action: BrowserAction, silent = false) => {
    const msg = await postAction(action, silent);
    if (!silent) reportAction(msg);
  }, [reportAction]);

  // ── Run voice/typed command ────────────────────────────────────────────────
  const runCommand = useCallback(async (cmd: string) => {
    if (!cmd.trim()) return;
    reportAction(`Running "${cmd}"…`);
    const msg = await postCommand(cmd);
    reportAction(msg);
  }, [reportAction]);

  // ── Stop camera ────────────────────────────────────────────────────────────
  const stopCamera = useCallback(() => {
    if (animRef.current) cancelAnimationFrame(animRef.current);
    animRef.current = null;
    CameraManager.stop();
    handLandmarkerRef.current?.close();
    handLandmarkerRef.current = null;
    faceLandmarkerRef.current?.close();
    faceLandmarkerRef.current = null;
    setCameraState('off');
    setHandGesture('No hand');
    setFaceDetected(false);
    gestureStateMachine.current.reset();
    clickSM.current.reset();
    scrollSM.current.reset();
    dwellEngine.current.cancel();
    cursorFilter.current.reset();
    headCursorFilter.current.reset();
    headNeutralRef.current = null;
  }, []);

  // ── Draw filters / overlays ────────────────────────────────────────────────
  const drawFilter = useCallback((
    faceResults: ReturnType<FaceLandmarker['detectForVideo']> | null,
    filterId: string,
  ) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (filterId === 'none') return;

    const lms = faceResults?.faceLandmarks?.[0];
    if (!lms) return;

    const W = canvas.width;
    const H = canvas.height;
    const pt = (i: number) => ({ x: (1 - lms[i].x) * W, y: lms[i].y * H });

    if (filterId === 'landmarks') {
      ctx.fillStyle = '#6366f1';
      for (const lm of lms) {
        ctx.beginPath();
        ctx.arc((1 - lm.x) * W, lm.y * H, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (filterId === 'outline') {
      // Draw face oval using silhouette landmarks (indices 10, 338, 297, 332, 284, ...)
      const contour = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      contour.forEach((i, idx) => {
        const p = pt(i);
        idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (filterId === 'glasses') {
      const leftEye = pt(33);
      const rightEye = pt(263);
      const eyeDist = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y);
      const r = eyeDist * 0.38;
      const bridgeW = eyeDist * 0.12;
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 2;
      ctx.fillStyle = 'rgba(99,102,241,0.12)';

      // Left lens
      ctx.beginPath();
      ctx.ellipse(leftEye.x, leftEye.y, r, r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();

      // Right lens
      ctx.beginPath();
      ctx.ellipse(rightEye.x, rightEye.y, r, r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();

      // Bridge
      ctx.beginPath();
      ctx.moveTo(leftEye.x + r, leftEye.y);
      ctx.lineTo(rightEye.x - r, rightEye.y);
      ctx.stroke();

      // Temples
      ctx.beginPath();
      ctx.moveTo(leftEye.x - r, leftEye.y);
      ctx.lineTo(leftEye.x - r - eyeDist * 0.3, leftEye.y - eyeDist * 0.05);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(rightEye.x + r, rightEye.y);
      ctx.lineTo(rightEye.x + r + eyeDist * 0.3, rightEye.y - eyeDist * 0.05);
      ctx.stroke();
    }

    if (filterId === 'ears') {
      const topHead = pt(10);
      const leftTemple = pt(234);
      const rightTemple = pt(454);
      const earSize = Math.hypot(rightTemple.x - leftTemple.x, rightTemple.y - leftTemple.y) * 0.28;

      const drawEar = (cx: number, cy: number, flip: boolean) => {
        ctx.fillStyle = '#f59e0b';
        ctx.strokeStyle = '#92400e';
        ctx.lineWidth = 1.5;
        const sx = flip ? -1 : 1;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(sx, 1);
        // Outer ear triangle
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-earSize * 0.5, -earSize * 1.1);
        ctx.lineTo(earSize * 0.5, -earSize * 1.1);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        // Inner ear
        ctx.fillStyle = '#fde68a';
        ctx.beginPath();
        ctx.moveTo(0, -earSize * 0.1);
        ctx.lineTo(-earSize * 0.25, -earSize * 0.85);
        ctx.lineTo(earSize * 0.25, -earSize * 0.85);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      };

      drawEar(leftTemple.x + earSize * 0.1, topHead.y - earSize * 0.1, false);
      drawEar(rightTemple.x - earSize * 0.1, topHead.y - earSize * 0.1, true);
    }
  }, []);

  // ── Main detection loop ────────────────────────────────────────────────────
  const detect = useCallback(() => {
    const video = videoRef.current;
    const s = settingsRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      animRef.current = requestAnimationFrame(detect);
      return;
    }

    const now = performance.now();
    let faceResults: ReturnType<FaceLandmarker['detectForVideo']> | null = null;

    // ── Face landmark detection (for head tracking & filters) ──────────────
    if (faceLandmarkerRef.current) {
      try {
        faceResults = faceLandmarkerRef.current.detectForVideo(video, now);
        const hasFace = (faceResults.faceLandmarks?.length ?? 0) > 0;
        setFaceDetected(hasFace);

        if (hasFace && s.trackingMode === 'head') {
          const lm = faceResults.faceLandmarks![0];
          // Use nose tip (landmark 1) as head position proxy
          const rawX = 1 - lm[1].x;
          const rawY = lm[1].y;

          if (!headNeutralRef.current) headNeutralRef.current = { x: rawX, y: rawY };
          const neutral = headNeutralRef.current;
          const sensitivity = s.headSensitivity;
          const deadzone = s.headNeutralZone;

          const dx = rawX - neutral.x;
          const dy = rawY - neutral.y;
          const ddx = Math.abs(dx) > deadzone ? (dx - Math.sign(dx) * deadzone) * sensitivity : 0;
          const ddy = Math.abs(dy) > deadzone ? (dy - Math.sign(dy) * deadzone) * sensitivity : 0;

          const [fx, fy] = headCursorFilter.current.filter(
            Math.max(0, Math.min(1, 0.5 + ddx)),
            Math.max(0, Math.min(1, 0.5 + ddy)),
            now,
          );

          if (now - lastPointerSendMs.current >= 50) {
            lastPointerSendMs.current = now;
            void sendAction({ type: 'pointer-move', x: fx, y: fy }, true);
          }

          // Dwell click in head mode
          if (s.clickMode !== 'gesture' && s.dwellEnabled) {
            // (dwell handled below with same path)
            const shouldClick = dwellEngine.current.update(fx, fy, null, now);
            setDwellState(dwellEngine.current.getState(now));
            if (shouldClick) void sendAction({ type: 'click', x: fx, y: fy });
          }
        }
      } catch { /* frame skip */ }
    }

    // ── Hand gesture detection ─────────────────────────────────────────────
    if (handLandmarkerRef.current && s.trackingMode === 'hand') {
      let results: ReturnType<GestureRecognizer['recognizeForVideo']> | null = null;
      try {
        results = handLandmarkerRef.current.recognizeForVideo(video, now);
      } catch { /* frame skip */ }

      const landmarks = results?.landmarks?.[0];
      const mpCategory = results?.gestures?.[0]?.[0]?.categoryName;
      const mpScore = results?.gestures?.[0]?.[0]?.score;

      const rawGesture = landmarks
        ? resolveGesture(mpCategory, mpScore, landmarks as { x: number; y: number; z: number }[], 0.6)
        : 'No hand';

      const confirmedGesture = gestureStateMachine.current.update(rawGesture, now);
      setHandGesture(confirmedGesture);
      setHandConfidence(mpScore ?? 0);

      const indexTip = landmarks?.[8];

      // ── Cursor movement (index finger) ─────────────────────────────────
      if (indexTip && confirmedGesture !== 'Closed fist') {
        const [fx, fy] = cursorFilter.current.filter(1 - indexTip.x, indexTip.y, now);
        if (now - lastPointerSendMs.current >= 50) {
          lastPointerSendMs.current = now;
          void sendAction({ type: 'pointer-move', x: fx, y: fy }, true);
        }

        // Dwell-to-click
        if ((s.clickMode === 'dwell' || s.clickMode === 'both') && s.dwellEnabled) {
          const shouldClick = dwellEngine.current.update(fx, fy, confirmedGesture, now);
          const ds = dwellEngine.current.getState(now);
          setDwellState(ds);
          if (shouldClick) {
            void sendAction({ type: 'click', x: fx, y: fy });
            reportAction('Dwell click executed.');
          }
        } else {
          dwellEngine.current.cancel();
          setDwellState({ phase: 'idle', progress: 0, targetKey: null });
        }
      } else if (!indexTip) {
        dwellEngine.current.cancel();
        setDwellState({ phase: 'idle', progress: 0, targetKey: null });
        cursorFilter.current.reset();
      }

      // ── Gesture click ──────────────────────────────────────────────────
      if (s.clickMode === 'gesture' || s.clickMode === 'both') {
        const clickResult = clickSM.current.update(confirmedGesture, now);
        setClickCharge(clickSM.current.getCharge(now));
        if (clickResult === 'fire' && indexTip) {
          const [cx, cy] = cursorFilter.current.filter(1 - indexTip.x, indexTip.y, now);
          void sendAction({ type: 'click', x: cx, y: cy });
          reportAction('Gesture click executed.');
        }
      } else {
        setClickCharge(0);
      }

      // ── Scroll ────────────────────────────────────────────────────────
      const scrollDir = scrollSM.current.update(confirmedGesture, now);
      if (scrollDir) {
        void sendAction({ type: 'scroll', direction: scrollDir });
      }
    }

    // ── Draw filter canvas ─────────────────────────────────────────────────
    if (s.activeFilter !== 'none') {
      drawFilter(faceResults, s.activeFilter);
    }

    animRef.current = requestAnimationFrame(detect);
  }, [sendAction, reportAction, drawFilter]);

  // ── Start camera + models ──────────────────────────────────────────────────
  const startCamera = useCallback(async (mode: 'hand' | 'head' | 'both' = 'hand') => {
    setCameraState('starting');
    try {
      const [vision, stream] = await Promise.all([
        FilesetResolver.forVisionTasks(MP_WASM_URL),
        CameraManager.start(),
      ]);

      // Load models in parallel
      const loadHand = (mode === 'hand' || mode === 'both') && !handLandmarkerRef.current
        ? GestureRecognizer.createFromOptions(vision, {
            baseOptions: { modelAssetPath: HAND_MODEL_URL },
            runningMode: 'VIDEO',
            numHands: 1,
          })
        : Promise.resolve(handLandmarkerRef.current);

      const loadFace = (mode === 'head' || mode === 'both' || settingsRef.current.activeFilter !== 'none')
        ? FaceLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: FACE_MODEL_URL },
            runningMode: 'VIDEO',
            numFaces: 1,
          })
        : Promise.resolve(null);

      const [hand, face] = await Promise.all([loadHand, loadFace]);
      handLandmarkerRef.current = hand;
      if (face) faceLandmarkerRef.current = face;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraState('ready');
      animRef.current = requestAnimationFrame(detect);
    } catch (err) {
      console.error('[FreeHand] Camera start error:', err);
      setCameraState('error');
    }
  }, [detect]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      autoListenRef.current = false;
      recognitionRef.current?.stop();
      stopCamera();
    };
  }, [stopCamera]);

  // ── Calibrate head neutral ─────────────────────────────────────────────────
  const calibrateHead = useCallback(() => {
    headNeutralRef.current = null;
    headCursorFilter.current.reset();
    reportAction('Head tracking calibrated. Look at center of screen.');
  }, [reportAction]);

  // ── Voice: toggle continuous listening ────────────────────────────────────
  function toggleVoice() {
    if (autoListenRef.current) {
      autoListenRef.current = false;
      recognitionRef.current?.stop();
      return;
    }
    const Ctor = (window as Window & { SpeechRecognition?: SpeechConstructor; webkitSpeechRecognition?: SpeechConstructor })
      .SpeechRecognition ?? (window as Window & { webkitSpeechRecognition?: SpeechConstructor }).webkitSpeechRecognition;

    if (!Ctor) { reportAction('Browser speech recognition unavailable.'); return; }

    const rec = new Ctor();
    rec.lang = 'en-US'; rec.interimResults = false; rec.continuous = true;
    autoListenRef.current = true;
    recognitionRef.current = rec;

    rec.onstart = () => setListening(true);
    rec.onend = () => {
      if (!autoListenRef.current) { setListening(false); return; }
      setTimeout(() => rec.start(), 250);
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech') return;
      autoListenRef.current = false;
      setListening(false);
      reportAction(
        e.error === 'not-allowed' || e.error === 'service-not-allowed'
          ? 'Microphone denied. Allow mic access for localhost.'
          : `Voice error: ${e.error}.`
      );
    };
    rec.onresult = (e) => {
      const t = e.results[e.results.length - 1][0].transcript;
      setVoiceCommand(t);
      setTypedCommand(t);
      void runCommand(t);
    };
    rec.start();
  }

  // ── Handle tracking mode change ───────────────────────────────────────────
  function switchTrackingMode(mode: AppSettings['trackingMode']) {
    updateSetting('trackingMode', mode);
    if (mode === 'off') {
      stopCamera();
    } else {
      if (cameraState !== 'ready') {
        void startCamera(mode === 'head' ? 'head' : 'hand');
      }
    }
    setHeadTracking(mode === 'head');
  }

  // ── Chip quick commands ───────────────────────────────────────────────────
  function handleChip(cmd: string) {
    setTypedCommand(cmd);
    void runCommand(cmd);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render helpers
  // ─────────────────────────────────────────────────────────────────────────
  function gestureLabel(g: GestureName): string {
    const m: Record<GestureName, string> = {
      'Open palm': 'Open Palm — Scroll Down',
      'Two-finger point': 'Two Fingers — Scroll Up',
      'Closed fist': 'Closed Fist — Click',
      'Thumbs up': 'Thumbs Up',
      'Index point': 'Index Point — Move Cursor',
      'No hand': 'No hand detected',
    };
    return m[g];
  }

  const cameraReady = cameraState === 'ready';

  // ─────────────────────────────────────────────────────────────────────────
  // Section renderers
  // ─────────────────────────────────────────────────────────────────────────
  function renderHome() {
    return (
      <div className="section-content">
        <div className="overview-grid">
          {/* Status card */}
          <div className="card status-card">
            <h3>Platform Status</h3>
            <div className="status-rows">
              <StatusRow label="Camera" value={cameraState} />
              <StatusRow label="Tracking Mode" value={settings.trackingMode} />
              <StatusRow label="Click Mode" value={settings.clickMode} />
              <StatusRow label="Hand Gesture" value={handGesture !== 'No hand' ? handGesture : '—'} active={handGesture !== 'No hand'} />
              <StatusRow label="Face Detected" value={faceDetected ? 'Yes' : 'No'} active={faceDetected} />
              <StatusRow label="Voice" value={listening ? 'Listening' : 'Off'} active={listening} />
              <StatusRow label="Dwell" value={settings.dwellEnabled ? `${settings.dwellMs}ms` : 'Disabled'} />
            </div>
            <div className="quick-controls">
              <button
                className={cameraReady ? 'btn-danger' : 'btn-primary'}
                onClick={() => cameraReady ? stopCamera() : void startCamera(settings.trackingMode === 'head' ? 'head' : 'hand')}
                disabled={cameraState === 'starting'}
              >
                {cameraState === 'starting' ? 'Starting…' : cameraReady ? 'Stop Camera' : 'Enable Camera'}
              </button>
              <button className="btn-secondary" onClick={toggleVoice}>
                {listening ? 'Stop Voice' : 'Start Voice'}
              </button>
            </div>
          </div>

          {/* Gesture reference */}
          <div className="card gesture-ref-card">
            <h3>Gesture Reference</h3>
            <div className="gesture-list">
              <GestureRef icon="☞" gesture="Index Finger" desc="Move cursor" />
              <GestureRef icon="✊" gesture="Closed Fist (hold 350ms)" desc="Click" />
              <GestureRef icon="🖐" gesture="Open Palm (hold 300ms)" desc="Scroll down" />
              <GestureRef icon="✌" gesture="Two Fingers (hold 300ms)" desc="Scroll up" />
            </div>
            <div style={{ marginTop: 16 }}>
              <h4 style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Voice Commands</h4>
              <div className="voice-examples">
                {['open youtube', 'search news', 'scroll down', 'open a new tab', 'press enter', 'back', 'forward'].map(c => (
                  <code key={c} className="voice-chip">{c}</code>
                ))}
              </div>
            </div>
          </div>

          {/* Last action */}
          <div className="card action-log-card">
            <h3>Last Action</h3>
            <div className="activity">
              {actionTimestamp && <span className="activity-ts">{actionTimestamp}</span>}
              <p className="activity-msg">{lastAction}</p>
            </div>
            {voiceCommand && <p className="voice-heard"><span>Heard:</span> "{voiceCommand}"</p>}
          </div>
        </div>
      </div>
    );
  }

  function renderHand() {
    return (
      <div className="section-content">
        <div className="hand-grid">
          {/* Camera preview */}
          <div className="card camera-card">
            <div className="card-heading">
              <h3>Camera Preview</h3>
              <span className={`badge badge-${cameraState === 'ready' ? 'green' : cameraState === 'error' ? 'red' : 'gray'}`}>
                {cameraState === 'ready' ? '● Live' : cameraState}
              </span>
            </div>
            <div className="video-wrap">
              <video ref={videoRef} muted playsInline />
              <canvas ref={canvasRef} className="filter-canvas" />
              {/* Click charge indicator */}
              {clickCharge > 0 && (
                <div className="charge-overlay">
                  <DwellRing progress={clickCharge} />
                  <span className="charge-label">{Math.round(clickCharge * 100)}%</span>
                </div>
              )}
              {/* Dwell progress */}
              {dwellState.phase === 'dwelling' && (
                <div className="charge-overlay dwell-overlay">
                  <DwellRing progress={dwellState.progress} />
                  <span className="charge-label">Dwell</span>
                </div>
              )}
              <div className="hud-overlay">
                <div className="hud-corner tl" /><div className="hud-corner tr" />
                <div className="hud-corner bl" /><div className="hud-corner br" />
              </div>
            </div>
            <div className="gesture-box">
              <span className="gesture-title">Detected</span>
              <span className={`gesture-value ${handGesture !== 'No hand' ? 'active' : ''}`}>
                {gestureLabel(handGesture)}
              </span>
            </div>
            {cameraReady && handGesture === 'Closed fist' && (
              <div className="fist-charge-bar">
                <div className="fist-charge-fill" style={{ width: `${clickCharge * 100}%` }} />
              </div>
            )}
            <button
              className={cameraReady ? 'btn-danger wide' : 'btn-primary wide'}
              onClick={() => cameraReady ? stopCamera() : void startCamera('hand')}
              disabled={cameraState === 'starting'}
              style={{ marginTop: 12 }}
            >
              {cameraState === 'starting' ? 'Starting…' : cameraReady ? 'Stop Camera' : 'Enable Hand Tracking'}
            </button>
          </div>

          {/* Controls */}
          <div className="card controls-card">
            <h3>Hand Tracking Controls</h3>
            <div className="settings-rows">
              <SliderRow
                label="Cursor Sensitivity"
                value={settings.cursorSensitivity}
                min={0.3} max={3} step={0.1}
                onChange={v => updateSetting('cursorSensitivity', v)}
                format={v => v.toFixed(1) + '×'}
              />
              <SliderRow
                label="Smoothing Strength"
                value={settings.cursorSmoothing}
                min={0.3} max={5} step={0.1}
                onChange={v => updateSetting('cursorSmoothing', v)}
                format={v => v.toFixed(1)}
                hint="Lower = less lag, more jitter. Higher = smoother but delayed."
              />
              <SliderRow
                label="Gesture Click Hold (ms)"
                value={settings.gestureClickMs}
                min={150} max={1000} step={25}
                onChange={v => updateSetting('gestureClickMs', v)}
                format={v => v + 'ms'}
              />
              <SliderRow
                label="Scroll Speed"
                value={settings.scrollSpeed}
                min={0.5} max={3} step={0.1}
                onChange={v => updateSetting('scrollSpeed', v)}
                format={v => v.toFixed(1) + '×'}
              />
            </div>

            <div className="section-divider" />
            <h4>Click Mode</h4>
            <div className="radio-group">
              {(['gesture', 'dwell', 'both'] as const).map(m => (
                <label key={m} className="radio-item">
                  <input type="radio" checked={settings.clickMode === m} onChange={() => updateSetting('clickMode', m)} />
                  <span>{m.charAt(0).toUpperCase() + m.slice(1)}</span>
                </label>
              ))}
            </div>

            {(settings.clickMode === 'dwell' || settings.clickMode === 'both') && (
              <>
                <div className="section-divider" />
                <h4>Dwell Settings</h4>
                <label className="toggle-row">
                  <span>Enable Dwell Click</span>
                  <input type="checkbox" checked={settings.dwellEnabled} onChange={e => updateSetting('dwellEnabled', e.target.checked)} />
                </label>
                <SliderRow
                  label="Dwell Duration (ms)"
                  value={settings.dwellMs}
                  min={500} max={5000} step={250}
                  onChange={v => updateSetting('dwellMs', v)}
                  format={v => (v / 1000).toFixed(1) + 's'}
                />
                <SliderRow
                  label="Stability Radius"
                  value={settings.dwellStabilityPx}
                  min={10} max={150} step={5}
                  onChange={v => updateSetting('dwellStabilityPx', v)}
                  format={v => v + 'px'}
                  hint="How much the cursor can drift before the dwell resets."
                />
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  function renderHead() {
    return (
      <div className="section-content">
        <div className="hand-grid">
          <div className="card camera-card">
            <div className="card-heading">
              <h3>Head Tracking Preview</h3>
              <span className={`badge badge-${faceDetected ? 'green' : 'gray'}`}>
                {faceDetected ? '● Face Detected' : 'No Face'}
              </span>
            </div>
            <div className="video-wrap">
              <video ref={videoRef} muted playsInline />
              <canvas ref={canvasRef} className="filter-canvas" />
              <div className="hud-overlay">
                <div className="hud-corner tl" /><div className="hud-corner tr" />
                <div className="hud-corner bl" /><div className="hud-corner br" />
              </div>
            </div>
            <div className="control-row" style={{ marginTop: 12, gap: 8 }}>
              <button
                className={cameraReady && settings.trackingMode === 'head' ? 'btn-danger' : 'btn-primary'}
                onClick={() => {
                  if (cameraReady && settings.trackingMode === 'head') {
                    switchTrackingMode('off');
                  } else {
                    updateSetting('trackingMode', 'head');
                    setHeadTracking(true);
                    void startCamera('head');
                  }
                }}
                disabled={cameraState === 'starting'}
              >
                {cameraState === 'starting' ? 'Starting…' : cameraReady && settings.trackingMode === 'head' ? 'Stop Head Tracking' : 'Enable Head Tracking'}
              </button>
              <button className="btn-secondary" onClick={calibrateHead} disabled={!cameraReady}>
                Recalibrate Center
              </button>
            </div>
          </div>

          <div className="card controls-card">
            <h3>Head Tracking Controls</h3>
            <p className="section-desc">
              Head tracking uses facial landmarks to drive the cursor. Look around to move.
              Calibrate by looking at the center of your screen.
            </p>
            <div className="settings-rows">
              <SliderRow
                label="Sensitivity"
                value={settings.headSensitivity}
                min={0.3} max={5} step={0.1}
                onChange={v => updateSetting('headSensitivity', v)}
                format={v => v.toFixed(1) + '×'}
              />
              <SliderRow
                label="Neutral Dead Zone"
                value={settings.headNeutralZone}
                min={0} max={0.2} step={0.005}
                onChange={v => updateSetting('headNeutralZone', v)}
                format={v => (v * 100).toFixed(1) + '%'}
                hint="Movements smaller than this are ignored to reduce jitter."
              />
            </div>
            <div className="section-divider" />
            <h4>Click Mode (head tracking)</h4>
            <p className="section-desc" style={{ marginBottom: 12 }}>
              Head movement alone does not click. Select dwell or gesture click below.
            </p>
            <div className="radio-group">
              {(['dwell', 'gesture'] as const).map(m => (
                <label key={m} className="radio-item">
                  <input type="radio" checked={settings.clickMode === m} onChange={() => updateSetting('clickMode', m)} />
                  <span>{m.charAt(0).toUpperCase() + m.slice(1)} click</span>
                </label>
              ))}
            </div>
            {settings.clickMode === 'dwell' && (
              <div style={{ marginTop: 12 }}>
                <label className="toggle-row">
                  <span>Enable Dwell Click</span>
                  <input type="checkbox" checked={settings.dwellEnabled} onChange={e => updateSetting('dwellEnabled', e.target.checked)} />
                </label>
                <SliderRow
                  label="Dwell Duration"
                  value={settings.dwellMs}
                  min={500} max={5000} step={250}
                  onChange={v => updateSetting('dwellMs', v)}
                  format={v => (v / 1000).toFixed(1) + 's'}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  function renderVoice() {
    const COMMAND_EXAMPLES = [
      { category: 'Navigation', cmds: ['open youtube', 'open google', 'go to github.com', 'back', 'forward'] },
      { category: 'Tabs', cmds: ['open a new tab', 'close tab', 'press Control T', 'press Control W'] },
      { category: 'Search', cmds: ['search machine learning', 'search for news', 'play lofi on youtube'] },
      { category: 'Typing', cmds: ['type hello world', 'write this is a test', 'press enter'] },
      { category: 'Scroll', cmds: ['scroll down', 'scroll up', 'page down', 'page up'] },
      { category: 'Media', cmds: ['pause', 'press Space'] },
    ];

    return (
      <div className="section-content">
        <div className="voice-grid">
          <div className="card voice-card">
            <div className="card-heading">
              <h3>Voice Control</h3>
              <span className={`badge badge-${listening ? 'green' : 'gray'}`}>
                {listening ? '● Listening' : 'Off'}
              </span>
            </div>
            <label className="field-label" htmlFor="typed-cmd">Type or speak a command</label>
            <div className="command-row">
              <input
                id="typed-cmd"
                value={typedCommand}
                onChange={e => setTypedCommand(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void runCommand(typedCommand)}
                placeholder="e.g. open youtube, search news…"
              />
              <button className={`btn-secondary mic-btn ${listening ? 'listening' : ''}`} onClick={toggleVoice}>
                {listening ? '■' : '🎙'}
              </button>
            </div>
            <button className="btn-primary wide" onClick={() => void runCommand(typedCommand)}>
              Execute Command
            </button>

            <div className="section-divider" />
            <div className="chips-label">Quick Actions</div>
            <div className="chips-grid">
              {['open youtube', 'open google', 'open a new tab', 'scroll down', 'scroll up', 'press enter', 'back', 'forward', 'pause'].map(c => (
                <div key={c} className="chip" onClick={() => handleChip(c)}>{c}</div>
              ))}
            </div>

            <div className="activity">
              {actionTimestamp && <span className="activity-ts">{actionTimestamp}</span>}
              <p className="activity-msg">{lastAction}</p>
            </div>
          </div>

          <div className="card command-ref-card">
            <h3>Supported Commands</h3>
            {COMMAND_EXAMPLES.map(cat => (
              <div key={cat.category} className="cmd-category">
                <div className="cmd-category-title">{cat.category}</div>
                <div className="chips-grid">
                  {cat.cmds.map(c => <code key={c} className="voice-chip">{c}</code>)}
                </div>
              </div>
            ))}
            <div className="section-divider" />
            <p className="section-desc">
              Commands not matched locally are sent to Gemini if <code>GEMINI_API_KEY</code> is configured in <code>.env</code>.
            </p>
          </div>
        </div>
      </div>
    );
  }

  function renderFilters() {
    return (
      <div className="section-content">
        <div className="filters-grid">
          <div className="card camera-card">
            <div className="card-heading">
              <h3>Live Preview</h3>
              <span className={`badge badge-${cameraState === 'ready' ? 'green' : 'gray'}`}>
                {cameraState === 'ready' ? '● Live' : 'Off'}
              </span>
            </div>
            <div className="video-wrap">
              <video ref={videoRef} muted playsInline />
              <canvas ref={canvasRef} className="filter-canvas" />
              <div className="hud-overlay">
                <div className="hud-corner tl" /><div className="hud-corner tr" />
                <div className="hud-corner bl" /><div className="hud-corner br" />
              </div>
            </div>
            <button
              className={cameraReady ? 'btn-danger wide' : 'btn-primary wide'}
              onClick={() => cameraReady ? stopCamera() : void startCamera('both')}
              disabled={cameraState === 'starting'}
              style={{ marginTop: 12 }}
            >
              {cameraState === 'starting' ? 'Starting…' : cameraReady ? 'Stop Camera' : 'Enable Camera for Filters'}
            </button>
            <p className="section-desc" style={{ marginTop: 10 }}>
              Filters render in a canvas layer above the video. Hand tracking is unaffected.
            </p>
          </div>

          <div className="card filter-gallery-card">
            <h3>Filter Gallery</h3>
            <div className="filter-grid">
              {FILTERS.map(f => (
                <div
                  key={f.id}
                  className={`filter-item ${settings.activeFilter === f.id ? 'selected' : ''}`}
                  onClick={() => updateSetting('activeFilter', f.id)}
                >
                  <div className="filter-preview">
                    {f.id === 'none' && <span style={{ fontSize: 24 }}>📷</span>}
                    {f.id === 'landmarks' && <span style={{ fontSize: 24, color: '#6366f1' }}>·</span>}
                    {f.id === 'outline' && <span style={{ fontSize: 24, color: '#38bdf8' }}>⬟</span>}
                    {f.id === 'glasses' && <span style={{ fontSize: 24 }}>🕶</span>}
                    {f.id === 'ears' && <span style={{ fontSize: 24 }}>🐱</span>}
                  </div>
                  <div className="filter-info">
                    <span className="filter-name">{f.label}</span>
                    <span className="filter-desc">{f.desc}</span>
                  </div>
                  {settings.activeFilter === f.id && <span className="filter-check">✓</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderSignLab() {
    return (
      <div className="section-content">
        <div className="sign-lab-grid">
          <div className="card sign-preview-card">
            <div className="card-heading">
              <h3>Sign Language Lab</h3>
              <span className="badge badge-amber">Preview</span>
            </div>
            <div className="video-wrap">
              <video ref={videoRef} muted playsInline />
              <div className="hud-overlay">
                <div className="hud-corner tl" /><div className="hud-corner tr" />
                <div className="hud-corner bl" /><div className="hud-corner br" />
              </div>
            </div>
            <div className="sign-status-row">
              <div className="sign-status-item">
                <span className="sign-status-label">Session</span>
                <span className="sign-status-value badge badge-gray">Not started</span>
              </div>
              <div className="sign-status-item">
                <span className="sign-status-label">Model</span>
                <span className="sign-status-value badge badge-gray">Not loaded</span>
              </div>
              <div className="sign-status-item">
                <span className="sign-status-label">Language</span>
                <span className="sign-status-value badge badge-gray">ASL (future)</span>
              </div>
            </div>
            <button className="btn-secondary wide" disabled style={{ marginTop: 12, opacity: 0.5 }}>
              Start Recognition Session (coming soon)
            </button>
          </div>

          <div className="card sign-results-card">
            <h3>Recognition Results</h3>
            <div className="sign-results-empty">
              <div className="sign-empty-icon">◈</div>
              <p>Recognition is not yet implemented.</p>
              <p className="section-desc">
                A future model will publish detected signs, confidence scores, and translated text here.
                The interface is ready to receive data.
              </p>
            </div>
            <div className="sign-placeholder-rows">
              <div className="sign-placeholder-row">
                <span className="spr-label">Detected Sign</span>
                <span className="spr-value">—</span>
              </div>
              <div className="sign-placeholder-row">
                <span className="spr-label">Confidence</span>
                <span className="spr-value">—</span>
              </div>
              <div className="sign-placeholder-row">
                <span className="spr-label">Translation</span>
                <span className="spr-value">—</span>
              </div>
            </div>
          </div>

          <div className="card sign-docs-card">
            <h3>Future Model Interface</h3>
            <p className="section-desc">
              A sign language recognition model should consume hand landmarks from the existing
              MediaPipe pipeline and publish results through the interface below. No frontend rewrite
              is required.
            </p>
            <div className="code-block">
              <pre>{`// Expected model integration contract

interface SignRecognitionResult {
  sign: string;         // e.g. "HELLO"
  confidence: number;   // 0–1
  translation?: string; // optional text
  handedness: 'Left' | 'Right' | 'Both';
}

// Connect model output here:
function onSignRecognized(result: SignRecognitionResult) {
  // Publish to results panel
}

// Input: MediaPipe hand landmarks (21 points × 3D)
// Run per frame; debounce to avoid jitter
// Required: two-handed support for full ASL`}</pre>
            </div>
            <div className="section-divider" />
            <p className="section-desc">
              <strong>Important:</strong> Standard hand gesture recognition is not equivalent to sign
              language understanding. A dedicated model trained on ASL/BSL/ISL hand shapes, movement
              trajectories, facial expressions, and body posture is required for accurate sign language
              interpretation.
            </p>
          </div>
        </div>
      </div>
    );
  }

  function renderSettings() {
    return (
      <div className="section-content">
        <div className="settings-page-grid">
          <div className="card">
            <h3>Tracking</h3>
            <div className="settings-rows">
              <div className="setting-row">
                <label className="field-label">Tracking Mode</label>
                <div className="radio-group horiz">
                  {(['off', 'hand', 'head'] as const).map(m => (
                    <label key={m} className="radio-item">
                      <input type="radio" checked={settings.trackingMode === m} onChange={() => switchTrackingMode(m)} />
                      <span>{m.charAt(0).toUpperCase() + m.slice(1)}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <label className="field-label">Click Mode</label>
                <div className="radio-group horiz">
                  {(['gesture', 'dwell', 'both'] as const).map(m => (
                    <label key={m} className="radio-item">
                      <input type="radio" checked={settings.clickMode === m} onChange={() => updateSetting('clickMode', m)} />
                      <span>{m.charAt(0).toUpperCase() + m.slice(1)}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <h3>Gesture Click</h3>
            <div className="settings-rows">
              <SliderRow label="Hold Duration" value={settings.gestureClickMs} min={100} max={1500} step={25}
                onChange={v => updateSetting('gestureClickMs', v)} format={v => v + 'ms'} />
            </div>
          </div>

          <div className="card">
            <h3>Dwell Click</h3>
            <div className="settings-rows">
              <label className="toggle-row">
                <span>Enable Dwell Click</span>
                <input type="checkbox" checked={settings.dwellEnabled} onChange={e => updateSetting('dwellEnabled', e.target.checked)} />
              </label>
              <SliderRow label="Dwell Duration" value={settings.dwellMs} min={500} max={5000} step={250}
                onChange={v => updateSetting('dwellMs', v)} format={v => (v / 1000).toFixed(1) + 's'} />
              <SliderRow label="Stability Radius" value={settings.dwellStabilityPx} min={10} max={150} step={5}
                onChange={v => updateSetting('dwellStabilityPx', v)} format={v => v + 'px'} />
            </div>
          </div>

          <div className="card">
            <h3>Cursor</h3>
            <div className="settings-rows">
              <SliderRow label="Sensitivity" value={settings.cursorSensitivity} min={0.3} max={3} step={0.1}
                onChange={v => updateSetting('cursorSensitivity', v)} format={v => v.toFixed(1) + '×'} />
              <SliderRow label="Smoothing (OneEuro cutoff)" value={settings.cursorSmoothing} min={0.3} max={5} step={0.1}
                onChange={v => updateSetting('cursorSmoothing', v)} format={v => v.toFixed(1)} />
              <SliderRow label="Scroll Speed" value={settings.scrollSpeed} min={0.5} max={3} step={0.1}
                onChange={v => updateSetting('scrollSpeed', v)} format={v => v.toFixed(1) + '×'} />
            </div>
          </div>

          <div className="card">
            <h3>Head Tracking</h3>
            <div className="settings-rows">
              <SliderRow label="Sensitivity" value={settings.headSensitivity} min={0.3} max={5} step={0.1}
                onChange={v => updateSetting('headSensitivity', v)} format={v => v.toFixed(1) + '×'} />
              <SliderRow label="Dead Zone" value={settings.headNeutralZone} min={0} max={0.2} step={0.005}
                onChange={v => updateSetting('headNeutralZone', v)} format={v => (v * 100).toFixed(1) + '%'} />
              <button className="btn-secondary" onClick={calibrateHead}>Recalibrate Head Neutral</button>
            </div>
          </div>

          <div className="card">
            <h3>Visual Filter</h3>
            <div className="radio-group">
              {FILTERS.map(f => (
                <label key={f.id} className="radio-item">
                  <input type="radio" checked={settings.activeFilter === f.id} onChange={() => updateSetting('activeFilter', f.id)} />
                  <span>{f.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="card">
            <h3>Reset</h3>
            <p className="section-desc">Reset all settings to factory defaults.</p>
            <button className="btn-danger" onClick={() => {
              const def = { trackingMode: 'off' as const, clickMode: 'gesture' as const, gestureClickMs: 350, dwellEnabled: false, dwellMs: 2000, dwellStabilityPx: 60, cursorSensitivity: 1.0, cursorSmoothing: 1.5, cursorBeta: 0.007, scrollSpeed: 1.0, headSensitivity: 1.2, headNeutralZone: 0.03, activeFilter: 'none', showLandmarkOverlay: true, autoStartCamera: false };
              setSettings(def); saveSettings(def);
            }}>
              Reset All Settings
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Main render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className={`app-shell ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
      {/* Sidebar */}
      <nav className="sidebar" aria-label="Main navigation">
        <div className="sidebar-brand">
          <span className="pulse" />
          <span className="brand-name">FreeHand</span>
        </div>
        <div className="sidebar-toggle-btn" onClick={() => setSidebarOpen(o => !o)} title={sidebarOpen ? 'Collapse' : 'Expand'}>
          {sidebarOpen ? '‹' : '›'}
        </div>
        <ul className="nav-list">
          {NAV_ITEMS.map(item => (
            <li key={item.id}>
              <button
                className={`nav-item ${section === item.id ? 'active' : ''}`}
                onClick={() => setSection(item.id)}
                title={item.label}
              >
                <span className="nav-icon">{item.icon}</span>
                {sidebarOpen && <span className="nav-label">{item.label}</span>}
              </button>
            </li>
          ))}
        </ul>
        {sidebarOpen && (
          <div className="sidebar-status">
            <div className={`ss-dot ${cameraReady ? 'green' : 'gray'}`} />
            <span>{cameraReady ? 'Camera Live' : 'Camera Off'}</span>
          </div>
        )}
      </nav>

      {/* Main content */}
      <main className="main-area">
        <div className="page-header">
          <h1 className="page-title">{NAV_ITEMS.find(n => n.id === section)?.label}</h1>
          <div className="page-status-pills">
            {cameraReady && <span className="pill pill-green">Camera</span>}
            {listening && <span className="pill pill-blue">Voice</span>}
            {settings.trackingMode !== 'off' && <span className="pill pill-indigo">{settings.trackingMode === 'hand' ? 'Hand' : 'Head'}</span>}
            {handGesture !== 'No hand' && <span className="pill pill-cyan">{handGesture}</span>}
          </div>
        </div>

        {section === 'home' && renderHome()}
        {section === 'hand' && renderHand()}
        {section === 'head' && renderHead()}
        {section === 'voice' && renderVoice()}
        {section === 'filters' && renderFilters()}
        {section === 'sign-lab' && renderSignLab()}
        {section === 'settings' && renderSettings()}
      </main>
    </div>
  );
}

// ─── Reusable sub-components ───────────────────────────────────────────────────
function StatusRow({ label, value, active }: { label: string; value: string; active?: boolean }) {
  return (
    <div className="status-row">
      <span className="sr-label">{label}</span>
      <span className={`sr-value ${active ? 'active' : ''}`}>{value}</span>
    </div>
  );
}

function GestureRef({ icon, gesture, desc }: { icon: string; gesture: string; desc: string }) {
  return (
    <div className="gesture-ref-row">
      <span className="gr-icon">{icon}</span>
      <div>
        <div className="gr-gesture">{gesture}</div>
        <div className="gr-desc">{desc}</div>
      </div>
    </div>
  );
}

function SliderRow({ label, value, min, max, step, onChange, format, hint }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; format: (v: number) => string; hint?: string;
}) {
  return (
    <div className="slider-row">
      <div className="slider-header">
        <span className="slider-label">{label}</span>
        <span className="slider-value">{format(value)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))} className="range-input" />
      {hint && <p className="slider-hint">{hint}</p>}
    </div>
  );
}

// ─── Mount ─────────────────────────────────────────────────────────────────────
declare global {
  interface Window {
    SpeechRecognition?: SpeechConstructor;
    webkitSpeechRecognition?: SpeechConstructor;
  }
}

createRoot(document.getElementById('root')!).render(<App />);
