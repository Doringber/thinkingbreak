// Thinking Break — pause / mode / settings / game-over overlay.
//
// One overlay element with swappable panels. It is intentionally skippable:
// the game is already running behind it and a single click drops straight back
// into play, because the whole point is not to navigate menus every time an
// agent starts a task.

import { MODES, MODE_IDS } from '../game/modes.js';

const $ = (id) => document.getElementById(id);

export function createMenu({
  onResume, onRestart, onModeChange, onSettingChange, getState, onJoinRoom, onLeaveRoom,
}) {
  const overlay = $('overlay');
  const panels = {
    pause: $('panel-pause'),
    modes: $('panel-modes'),
    settings: $('panel-settings'),
    gameover: $('panel-gameover'),
    multiplayer: $('panel-multiplayer'),
  };

  let current = null;
  let visible = false;

  function show(panel) {
    current = panel;
    visible = true;
    overlay.classList.add('show');
    for (const [name, node] of Object.entries(panels)) {
      node?.classList.toggle('hidden', name !== panel);
    }
  }

  function hide() {
    visible = false;
    current = null;
    overlay.classList.remove('show');
  }

  // ── Mode list ─────────────────────────────────────────────────────────────
  const modeList = $('mode-list');
  if (modeList) {
    for (const id of MODE_IDS) {
      const mode = MODES[id];
      const btn = document.createElement('button');
      btn.className = 'mode-card';
      btn.dataset.mode = id;
      btn.innerHTML = `
        <span class="mode-card-name"></span>
        <span class="mode-card-blurb"></span>
        <span class="mode-card-best"></span>`;
      btn.querySelector('.mode-card-name').textContent = mode.name;
      btn.querySelector('.mode-card-blurb').textContent = mode.blurb;
      btn.addEventListener('click', () => {
        onModeChange(id);
        hide();
        onResume();
      });
      modeList.appendChild(btn);
    }
  }

  function refreshModeCards() {
    const state = getState();
    for (const btn of modeList?.querySelectorAll('.mode-card') ?? []) {
      const id = btn.dataset.mode;
      btn.classList.toggle('active', id === state.modeId);
      const best = state.highScores[id] ?? 0;
      btn.querySelector('.mode-card-best').textContent = best > 0 ? `BEST ${best}` : 'NEW';
    }
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  const bind = (id, event, handler) => $(id)?.addEventListener(event, handler);

  bind('set-sensitivity', 'input', (e) => {
    const value = Number(e.target.value) / 100000;
    onSettingChange({ sensitivity: value });
    $('set-sensitivity-value').textContent = (value * 1000).toFixed(2);
  });
  bind('set-fov', 'input', (e) => {
    const value = Number(e.target.value);
    onSettingChange({ fov: value });
    $('set-fov-value').textContent = String(value);
  });
  bind('set-volume', 'input', (e) => {
    const value = Number(e.target.value) / 100;
    onSettingChange({ masterVolume: value, sfxEnabled: value > 0 });
    $('set-volume-value').textContent = `${Math.round(value * 100)}%`;
  });
  bind('set-invert', 'change', (e) => onSettingChange({ invertY: e.target.checked }));
  bind('set-fps', 'change', (e) => onSettingChange({ showFps: e.target.checked }));

  for (const node of document.querySelectorAll('[data-quality]')) {
    node.addEventListener('click', () => {
      onSettingChange({ quality: node.dataset.quality });
      refreshSettings();
    });
  }
  for (const node of document.querySelectorAll('[data-difficulty]')) {
    node.addEventListener('click', () => {
      onSettingChange({ difficulty: node.dataset.difficulty });
      refreshSettings();
    });
  }

  function refreshSettings() {
    const { settings } = getState();
    const sens = $('set-sensitivity');
    if (sens) {
      sens.value = String(Math.round(settings.sensitivity * 100000));
      $('set-sensitivity-value').textContent = (settings.sensitivity * 1000).toFixed(2);
    }
    const fov = $('set-fov');
    if (fov) {
      fov.value = String(settings.fov);
      $('set-fov-value').textContent = String(settings.fov);
    }
    const vol = $('set-volume');
    if (vol) {
      vol.value = String(Math.round(settings.masterVolume * 100));
      $('set-volume-value').textContent = `${Math.round(settings.masterVolume * 100)}%`;
    }
    const invert = $('set-invert');
    if (invert) invert.checked = settings.invertY;
    const fpsToggle = $('set-fps');
    if (fpsToggle) fpsToggle.checked = settings.showFps;

    for (const node of document.querySelectorAll('[data-quality]')) {
      node.classList.toggle('active', node.dataset.quality === settings.quality);
    }
    for (const node of document.querySelectorAll('[data-difficulty]')) {
      node.classList.toggle('active', node.dataset.difficulty === settings.difficulty);
    }
  }

  // ── Buttons ───────────────────────────────────────────────────────────────
  bind('btn-resume', 'click', () => { hide(); onResume(); });
  bind('btn-modes', 'click', () => { refreshModeCards(); show('modes'); });
  bind('btn-settings', 'click', () => { refreshSettings(); show('settings'); });
  bind('btn-restart', 'click', () => { onRestart(); hide(); onResume(); });
  bind('btn-settings-back', 'click', () => show('pause'));
  bind('btn-modes-back', 'click', () => show('pause'));
  bind('btn-again', 'click', () => { onRestart(); hide(); onResume(); });
  bind('btn-gameover-modes', 'click', () => { refreshModeCards(); show('modes'); });

  // ── Multiplayer ────────────────────────────────────────────────────────────
  bind('btn-multiplayer', 'click', () => { refreshMultiplayerPanel(); show('multiplayer'); });
  bind('btn-multiplayer-back', 'click', () => show('pause'));

  function currentRoomCodeInput() {
    return $('mp-room-code')?.value ?? '';
  }

  bind('mp-join', 'click', () => onJoinRoom?.(currentRoomCodeInput()));
  bind('mp-leave', 'click', () => onLeaveRoom?.());
  $('mp-room-code')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    onJoinRoom?.(currentRoomCodeInput());
  });
  // Room codes read as a single word; force the case as you type rather than
  // making everyone remember it is case-sensitive.
  $('mp-room-code')?.addEventListener('input', (e) => {
    const upper = e.target.value.toUpperCase();
    if (upper !== e.target.value) e.target.value = upper;
  });

  // Sharing a room is the whole point of having one, so the link is one click
  // away whenever we're in a room. `writeText` needs a user gesture and can be
  // refused outright (insecure context, permission policy in an editor
  // webview), so a refusal has to say so rather than look like nothing.
  let inviteUrl = '';
  bind('mp-copy-invite', 'click', async () => {
    const btn = $('mp-copy-invite');
    if (!btn || !inviteUrl) return;
    const restore = () => { btn.textContent = 'Copy invite link'; };
    try {
      await navigator.clipboard.writeText(inviteUrl);
      btn.textContent = 'Copied — paste it to your team';
    } catch {
      btn.textContent = 'Copy failed — link is in the room code box';
      const codeInput = $('mp-room-code');
      if (codeInput) {
        codeInput.value = inviteUrl;
        codeInput.select?.();
      }
    }
    setTimeout(restore, 2600);
  });

  function refreshMultiplayerPanel() {
    const codeInput = $('mp-room-code');
    if (codeInput && !codeInput.value) codeInput.value = getState().roomCode ?? '';
  }

  function renderMultiplayerRoster(roster) {
    const container = $('mp-roster');
    if (!container) return;
    container.replaceChildren();
    if (!roster || roster.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'mp-empty';
      empty.textContent = 'No one else here yet — share the room code with your team.';
      container.appendChild(empty);
      return;
    }
    for (const p of roster) {
      const row = document.createElement('div');
      row.className = 'mp-roster-row' + (p.alive === false ? ' roster-dead' : '');

      const dot = document.createElement('span');
      dot.className = 'roster-dot';
      const [r, g, b] = p.color ?? [0.6, 0.6, 0.6];
      dot.style.background = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

      // textContent throughout: every field here can come straight from the
      // network, and a crafted name must never be able to inject markup.
      const name = document.createElement('span');
      name.className = 'mp-roster-name';
      name.textContent = p.name ?? '?';

      const busy = p.agentState === 'busy';
      const state = document.createElement('span');
      state.className = 'mp-roster-state ' + (busy ? 'busy' : 'idle');
      state.textContent = busy ? 'Agent working' : 'Agent idle';

      const kills = document.createElement('span');
      kills.className = 'mp-roster-kills';
      kills.textContent = `${p.kills ?? 0} kills`;

      row.append(dot, name, state, kills);
      container.appendChild(row);
    }
  }

  return {
    get visible() { return visible; },
    get panel() { return current; },

    /** Called by the game whenever the run/pause state flips. */
    setPaused(paused, reason = 'manual') {
      if (!paused) { hide(); return; }
      // Game over owns the overlay until the player chooses what is next.
      if (current === 'gameover') return;
      const label = $('pause-reason');
      if (label) {
        label.textContent = reason === 'agent'
          ? 'Your agent finished — session saved.'
          : reason === 'boot'
            ? 'Ready when you are.'
            : 'Paused.';
      }
      const stats = getState();
      const summary = $('pause-summary');
      if (summary) {
        summary.textContent = `${stats.modeName} · ${stats.score} pts · round ${stats.round}`;
      }
      show('pause');
    },

    showGameOver(result) {
      $('go-score').textContent = String(result.score);
      $('go-kills').textContent = String(result.kills);
      $('go-headshots').textContent = String(result.headshots);
      $('go-streak').textContent = String(result.bestStreak);
      $('go-best').textContent = String(result.highScore);
      $('go-title').textContent = result.outcome === 'win' ? 'CLEARED' : 'ELIMINATED';
      $('go-mode').textContent = result.modeName;
      $('go-record').classList.toggle('hidden', !result.record);
      show('gameover');
    },

    showModes() { refreshModeCards(); show('modes'); },
    refreshSettings,
    hide,

    /** Called by the game on every connection-status or roster change. */
    multiplayerState(state) {
      const statusEl = $('mp-status');
      const joinBtn = $('mp-join');
      const leaveBtn = $('mp-leave');
      const codeInput = $('mp-room-code');

      const label = {
        disconnected: 'Not connected.',
        connecting: 'Connecting…',
        connected: `Connected — room ${state.roomCode}`,
        error: state.error ?? 'Something went wrong.',
      }[state.status] ?? '';
      if (statusEl) {
        statusEl.textContent = label;
        statusEl.classList.toggle('mp-error', state.status === 'error');
      }
      joinBtn?.classList.toggle('hidden', state.status === 'connected' || state.status === 'connecting');
      leaveBtn?.classList.toggle('hidden', state.status !== 'connected');
      if (codeInput && state.roomCode && !codeInput.value) codeInput.value = state.roomCode;

      inviteUrl = state.inviteUrl ?? '';
      $('mp-copy-invite')?.classList.toggle('hidden', state.status !== 'connected' || !inviteUrl);

      renderMultiplayerRoster(state.roster);
    },
  };
}
