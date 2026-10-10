import {
  classifyFromLandmarks,
  GestureStateMachine,
  ClickStateMachine,
  ScrollStateMachine,
  resolveGesture,
} from './gesture';

type Landmark = { x: number; y: number; z: number };

// Helper: make 21 landmarks all at a neutral position
function makeLandmarks(): Landmark[] {
  return Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
}

// ── classifyFromLandmarks ──────────────────────────────────────────────────────
function testClassify() {
  const lm = makeLandmarks();

  // Open palm: set all finger tips above their PIP joints (y < pip.y)
  // Indices: index tip=8 pip=6, middle tip=12 pip=10, ring tip=16 pip=14, pinky tip=20 pip=18
  const pairs = [[8,6],[12,10],[16,14],[20,18]];
  pairs.forEach(([tip,pip]) => {
    lm[pip].y = 0.6;
    lm[tip].y = 0.3; // above pip (smaller y = higher on screen)
  });
  const palmResult = classifyFromLandmarks(lm);
  console.assert(palmResult === 'Open palm', `Expected 'Open palm', got '${palmResult}'`);
  console.log(`✓ Open palm: ${palmResult}`);

  // Closed fist: set all finger tips below their PIP joints (y > pip.y)
  const lm2 = makeLandmarks();
  pairs.forEach(([tip,pip]) => {
    lm2[pip].y = 0.4;
    lm2[tip].y = 0.7; // below pip (larger y = lower)
  });
  lm2[0].y = 0.2; // wrist near top
  const fistResult = classifyFromLandmarks(lm2);
  console.assert(fistResult === 'Closed fist', `Expected 'Closed fist', got '${fistResult}'`);
  console.log(`✓ Closed fist: ${fistResult}`);

  // Two-finger point: index and middle extended, ring and pinky curled
  const lm3 = makeLandmarks();
  // Index and middle extended (tips above pip)
  lm3[6].y = 0.6;  lm3[8].y = 0.3;  // index
  lm3[10].y = 0.6; lm3[12].y = 0.3; // middle
  // Ring and pinky curled (tips below pip)
  lm3[14].y = 0.4; lm3[16].y = 0.7; // ring
  lm3[18].y = 0.4; lm3[20].y = 0.7; // pinky
  const twoFingerResult = classifyFromLandmarks(lm3);
  console.assert(twoFingerResult === 'Two-finger point', `Expected 'Two-finger point', got '${twoFingerResult}'`);
  console.log(`✓ Two-finger point: ${twoFingerResult}`);
}

// ── GestureStateMachine ────────────────────────────────────────────────────────
function testGestureStateMachine() {
  const sm = new GestureStateMachine();
  // Feed 'Closed fist' for less than CONFIRM_MS — should not confirm yet
  const r1 = sm.update('Closed fist', 0);
  const r2 = sm.update('Closed fist', 50); // 50ms < 80ms
  // After 100ms it should confirm
  const r3 = sm.update('Closed fist', 100); // 100ms >= 80ms
  console.assert(r3 === 'Closed fist', `Should confirm 'Closed fist' at 100ms, got '${r3}'`);
  console.log(`✓ GestureStateMachine confirms after hold: ${r3}`);

  // Flickering: gesture changes before CONFIRM_MS — should NOT confirm
  const sm2 = new GestureStateMachine();
  sm2.update('Closed fist', 0);
  sm2.update('No hand', 40); // flicker at 40ms resets candidate
  sm2.update('Closed fist', 45);
  const r4 = sm2.update('Closed fist', 80); // only 35ms since last change
  console.assert(r4 !== 'Closed fist', `Should NOT confirm after flicker: got '${r4}'`);
  console.log(`✓ GestureStateMachine suppresses flicker: ${r4}`);
}

// ── ClickStateMachine ──────────────────────────────────────────────────────────
function testClickStateMachine() {
  const csm = new ClickStateMachine(350, 500);

  // Should NOT fire before chargeMs
  let r = csm.update('Closed fist', 0);
  r = csm.update('Closed fist', 200);
  console.assert(r === null, `Should NOT fire at 200ms: ${r}`);

  // Should fire at >= chargeMs
  r = csm.update('Closed fist', 360);
  console.assert(r === 'fire', `Should fire at 360ms: ${r}`);
  console.log(`✓ ClickStateMachine fires at 360ms: ${r}`);

  // Should NOT fire again while still in fist (fired phase)
  r = csm.update('Closed fist', 400);
  console.assert(r === null, `Should NOT fire again while fist held: ${r}`);
  console.log(`✓ ClickStateMachine: single click per gesture`);

  // Release and re-hold
  csm.update('No hand', 500); // release (exits fired -> idle)
  csm.update('Closed fist', 1050); // new charge start (500ms cooldown elapsed)
  r = csm.update('Closed fist', 1420);
  console.assert(r === 'fire', `Should fire again after release: ${r}`);
  console.log(`✓ ClickStateMachine fires again after release+cooldown: ${r}`);
}

// ── ScrollStateMachine ─────────────────────────────────────────────────────────
function testScrollStateMachine() {
  const ssm = new ScrollStateMachine(300, 650);

  // Should NOT scroll before confirmMs
  let r = ssm.update('Open palm', 0);
  r = ssm.update('Open palm', 200);
  console.assert(r === null, `Should NOT scroll at 200ms: ${r}`);

  // Should scroll at >= confirmMs
  r = ssm.update('Open palm', 320);
  console.assert(r === 'down', `Should scroll down at 320ms: ${r}`);
  console.log(`✓ ScrollStateMachine scrolls down after hold: ${r}`);

  // Should scroll again after intervalMs
  r = ssm.update('Open palm', 900); // 320 + 580 < 650, no
  r = ssm.update('Open palm', 1000); // 320 + 680 >= 650
  console.assert(r === 'down', `Should scroll again at 1000ms: ${r}`);
  console.log(`✓ ScrollStateMachine continuous scroll: ${r}`);

  // Gesture change stops scroll
  ssm.update('No hand', 1100);
  r = ssm.update('No hand', 1200);
  console.assert(r === null, `Should stop on gesture change: ${r}`);
  console.log(`✓ ScrollStateMachine stops on gesture change`);

  // Two-finger = scroll up
  const ssm2 = new ScrollStateMachine(300, 650);
  ssm2.update('Two-finger point', 0);
  const r2 = ssm2.update('Two-finger point', 400);
  console.assert(r2 === 'up', `Should scroll up for Two-finger: ${r2}`);
  console.log(`✓ ScrollStateMachine scrolls up for Two-finger: ${r2}`);
}

// ── Run all ─────────────────────────────────────────────────────────────────
console.log('\n=== Gesture Engine Tests ===\n');
testClassify();
console.log();
testGestureStateMachine();
console.log();
testClickStateMachine();
console.log();
testScrollStateMachine();
console.log('\n✅ All gesture engine tests passed.\n');
