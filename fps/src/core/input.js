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

export function createInput(canvas, { onAction } = {}) {
  const keys = new Set();
  const state = {
    mouseDX: 0,
    mouseDY: 0,
    firing: false,
    aiming: false,
    wheel: 0,
    pointerLocked: false,
    lastInputAt: 0,
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

  return {
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
    },
    dispose() {
      for (const fn of teardown) fn();
      keys.clear();
    },
  };
}
