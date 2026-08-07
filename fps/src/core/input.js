// Thinking Break — keyboard, mouse and pointer-lock input.
//
// Key state is tracked by `event.code` so the game plays the same on any
// keyboard layout. Mouse deltas accumulate between frames and are drained by
// the game loop, which keeps aiming smooth when the render rate and the mouse
// report rate differ.

const MOVEMENT_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'KeyC', 'KeyR',
  'Digit1', 'Digit2', 'Digit3', 'KeyQ', 'Tab',
]);

// Full stick deflection, in CSS pixels of travel from where the thumb landed.
const STICK_RADIUS = 52;
// A thumb drags far fewer pixels than a mouse moves for the same intended
// turn, so touch look is scaled up before it reaches the shared sensitivity.
const TOUCH_LOOK_SCALE = 1.9;
// Past this deflection the player is asking to run, which saves a sprint
// button on a screen that has no room for one.
const SPRINT_AT = 0.85;

export function createInput(canvas, { onAction, onTouchStick } = {}) {
  const keys = new Set();
  const state = {
    mouseDX: 0,
    mouseDY: 0,
    firing: false,
    aiming: false,
    wheel: 0,
    pointerLocked: false,
    lastInputAt: 0,
    // ── Touch ──────────────────────────────────────────────────────────────
    // Set on the first real touch rather than sniffed from the user agent: a
    // touchscreen laptop should keep mouse and keyboard until someone actually
    // uses a finger.
    touchActive: false,
    moveX: 0,   // -1..1 strafe, right positive
    moveY: 0,   // -1..1 forward, away from the player positive
    sprinting: false,
    // A tap can start and finish inside the gap between two frames, leaving
    // `firing` false again before the loop ever looks at it — a press that
    // visibly does nothing. This latches one frame of fire intent per tap; the
    // game clears it once it has been considered.
    fireLatch: false,
  };
  const teardown = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    teardown.push(() => target.removeEventListener(type, fn, opts));
  };

  const action = (name, payload) => onAction?.(name, payload);

  on(window, 'keydown', (e) => {
    if (e.repeat) {
      if (MOVEMENT_CODES.has(e.code)) e.preventDefault();
      return;
    }
    keys.add(e.code);
    state.lastInputAt = performance.now();
    // Only swallow keys the game actually uses, so browser/editor shortcuts
    // outside that set keep working while the panel has focus.
    if (MOVEMENT_CODES.has(e.code)) e.preventDefault();
    action('keydown', e.code);
  });

  on(window, 'keyup', (e) => {
    keys.delete(e.code);
    action('keyup', e.code);
  });

  // A lost window focus must not leave keys stuck down.
  on(window, 'blur', () => {
    keys.clear();
    state.firing = false;
  });

  on(canvas, 'mousedown', (e) => {
    if (!state.pointerLocked) { action('requestLock'); return; }
    if (e.button === 0) state.firing = true;
    if (e.button === 2) state.aiming = true;
    action('mousedown', e.button);
  });

  on(window, 'mouseup', (e) => {
    if (e.button === 0) state.firing = false;
    if (e.button === 2) state.aiming = false;
  });

  on(canvas, 'contextmenu', (e) => e.preventDefault());

  on(window, 'mousemove', (e) => {
    if (!state.pointerLocked) return;
    state.mouseDX += e.movementX || 0;
    state.mouseDY += e.movementY || 0;
    state.lastInputAt = performance.now();
  });

  on(window, 'wheel', (e) => {
    if (!state.pointerLocked) return;
    state.wheel += Math.sign(e.deltaY);
    e.preventDefault();
  }, { passive: false });

  on(document, 'pointerlockchange', () => {
    state.pointerLocked = document.pointerLockElement === canvas;
    if (!state.pointerLocked) {
      keys.clear();
      state.firing = false;
    }
    action('pointerlockchange', state.pointerLocked);
  });

  on(document, 'pointerlockerror', () => action('pointerlockerror'));

  // ── Touch ──────────────────────────────────────────────────────────────────
  // A phone has no pointer lock and no keyboard, so touch drives the same two
  // channels everything else does: look adds to the mouse-delta accumulator,
  // and the on-screen buttons synthesise the key codes the game already
  // handles. The game loop stays unaware there is a second input method.
  //
  // The left of the screen is a thumbstick that appears wherever it is touched
  // — a fixed one is a constant hunt for a spot you cannot see under your own
  // hand. Anywhere else drags to look, so a second finger can aim while the
  // first is still moving.

  const stick = { id: null, ox: 0, oy: 0 };
  let lookId = null;
  let lookX = 0;
  let lookY = 0;

  function markTouchActive() {
    if (state.touchActive) return;
    state.touchActive = true;
    document.body.classList.add('touch-input');
    action('touchactive');
  }

  // Any touch anywhere counts, not just one on the canvas — otherwise the
  // controls stay invisible until after the player has tapped Play and is
  // already looking at an arena with nothing to press.
  on(window, 'touchstart', markTouchActive, { passive: true });

  function updateStick(cx, cy) {
    const dx = cx - stick.ox;
    const dy = cy - stick.oy;
    const dist = Math.hypot(dx, dy);
    const scale = dist > STICK_RADIUS ? STICK_RADIUS / dist : 1;
    const nx = (dx * scale) / STICK_RADIUS;
    const ny = (dy * scale) / STICK_RADIUS;
    state.moveX = nx;
    state.moveY = -ny; // screen y grows downward; forward is up
    state.sprinting = Math.hypot(nx, ny) > SPRINT_AT;
    onTouchStick?.({ active: true, baseX: stick.ox, baseY: stick.oy, dx: dx * scale, dy: dy * scale });
  }

  function releaseStick() {
    stick.id = null;
    state.moveX = 0;
    state.moveY = 0;
    state.sprinting = false;
    onTouchStick?.({ active: false });
  }

  on(canvas, 'pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    markTouchActive();
    state.lastInputAt = performance.now();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* capture is optional */ }

    // The left edge is the movement zone. Only the first finger there claims
    // the stick, so a stray palm cannot steal it mid-run.
    if (e.clientX < window.innerWidth * 0.45 && stick.id === null) {
      stick.id = e.pointerId;
      stick.ox = e.clientX;
      stick.oy = e.clientY;
      updateStick(e.clientX, e.clientY);
    } else if (lookId === null) {
      lookId = e.pointerId;
      lookX = e.clientX;
      lookY = e.clientY;
    }
    e.preventDefault();
  }, { passive: false });

  on(canvas, 'pointermove', (e) => {
    if (e.pointerType !== 'touch') return;
    if (e.pointerId === stick.id) {
      updateStick(e.clientX, e.clientY);
    } else if (e.pointerId === lookId) {
      state.mouseDX += (e.clientX - lookX) * TOUCH_LOOK_SCALE;
      state.mouseDY += (e.clientY - lookY) * TOUCH_LOOK_SCALE;
      lookX = e.clientX;
      lookY = e.clientY;
      state.lastInputAt = performance.now();
    }
    e.preventDefault();
  }, { passive: false });

  const endTouch = (e) => {
    if (e.pointerType !== 'touch') return;
    if (e.pointerId === stick.id) releaseStick();
    else if (e.pointerId === lookId) lookId = null;
  };
  on(canvas, 'pointerup', endTouch);
  on(canvas, 'pointercancel', endTouch);

  /**
   * Wire an on-screen button to a key code. Held buttons (fire, jump) keep the
   * code down for as long as the finger is; tap buttons fire once, matching
   * what a keypress would do.
   */
  function bindTouchButton(el, { code, hold = false, firing = false }) {
    if (!el) return;
    const press = (e) => {
      e.preventDefault();
      e.stopPropagation();
      markTouchActive();
      state.lastInputAt = performance.now();
      if (firing) {
        state.firing = true;
        state.fireLatch = true;
      }
      if (code) {
        if (hold) keys.add(code);
        action('keydown', code);
      }
      el.classList.add('pressed');
    };
    const release = (e) => {
      e?.preventDefault();
      if (firing) state.firing = false;
      if (code && hold) {
        keys.delete(code);
        action('keyup', code);
      }
      el.classList.remove('pressed');
    };
    on(el, 'pointerdown', press, { passive: false });
    on(el, 'pointerup', release);
    on(el, 'pointercancel', release);
    on(el, 'pointerleave', release);
    // Without this a long press pops up the text-selection/callout UI mid-fight.
    on(el, 'contextmenu', (e) => e.preventDefault());
  }

  return {
    bindTouchButton,
    state,
    isDown: (code) => keys.has(code),
    anyDown: (...codes) => codes.some((c) => keys.has(c)),
    /** Read and reset the accumulated mouse delta. */
    drainMouse() {
      const dx = state.mouseDX;
      const dy = state.mouseDY;
      state.mouseDX = 0;
      state.mouseDY = 0;
      return { dx, dy };
    },
    drainWheel() {
      const w = state.wheel;
      state.wheel = 0;
      return w;
    },
    async requestLock() {
      if (state.pointerLocked) return true;
      try {
        // `unadjustedMovement` skips OS pointer acceleration where supported;
        // Safari and older Chromium reject the options object, hence the retry.
        const result = canvas.requestPointerLock({ unadjustedMovement: true });
        if (result?.catch) await result.catch(() => canvas.requestPointerLock());
        return true;
      } catch {
        try { canvas.requestPointerLock(); return true; } catch { return false; }
      }
    },
    releaseLock() {
      if (document.pointerLockElement) {
        try { document.exitPointerLock(); } catch { /* already released */ }
      }
    },
    clearKeys() {
      keys.clear();
      state.firing = false;
      state.aiming = false;
      // A pause must not leave the stick deflected, or the player walks into a
      // wall for as long as the menu is open.
      releaseStick();
      lookId = null;
    },
    dispose() {
      for (const fn of teardown) fn();
      keys.clear();
    },
  };
}
