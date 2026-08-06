// Thinking Break — entry point.
//
// Boots the game once, wires it to the agent lifecycle bridge, and gets out of
// the way. Nothing here runs per-frame.

import { Game } from './game/game.js';
import { createHud } from './ui/hud.js';
import { createMenu } from './ui/menu.js';
import { createStore } from './core/storage.js';
import { getMode } from './game/modes.js';
import { createAgentBridge, readBootConfig, signalAgent } from './lifecycle/bridge.js';
import { roomCodeFromUrl } from './multiplayer/protocol.js';

const boot = readBootConfig();
const canvas = document.getElementById('scene');
const fatal = document.getElementById('fatal');

function showFatal(message) {
  if (!fatal) return;
  document.getElementById('fatal-message').textContent = message;
  fatal.classList.remove('hidden');
}

let game;
let bridge;

try {
  const store = createStore();
  const hud = createHud();

  // The menu needs the game and the game needs the menu, so the menu reads
  // through a getter that is only called after both exist.
  const menu = createMenu({
    onResume: () => {
      game.resume();
      game.input.requestLock();
    },
    onRestart: () => game.restart(),
    onModeChange: (modeId) => game.restart(modeId),
    onSettingChange: (patch) => game.updateSettings(patch),
    onJoinRoom: (code) => { void game.joinMultiplayer(code); },
    onLeaveRoom: () => { void game.leaveMultiplayer(); },
    getState: () => ({
      modeId: game?.mode.modeId ?? 'survival',
      modeName: getMode(game?.mode.modeId ?? 'survival').name,
      score: game?.mode.score ?? 0,
      round: game?.mode.round ?? 1,
      highScores: game?.save.highScores ?? {},
      settings: game?.settings ?? store.load().settings,
      roomCode: game?.save.multiplayer?.roomCode ?? '',
    }),
  });

  game = new Game({ canvas, hud, store, menu, embedded: boot.embedded });
  menu.refreshSettings();

  // Join a team room automatically, so nobody has to type a code.
  //
  // An invite link (`?room=CODE`) wins over the remembered room: following a
  // link is an explicit request to go *there*, and it's what lets one pasted
  // URL — or the editor extension's configured room — put a whole team in the
  // same arena with no setup. Failing that, rejoin last session's room, since
  // every reload is an editor-panel resume and retyping the code each time
  // would mean teammates stop seeing each other.
  const invitedRoom = roomCodeFromUrl(location.search);
  const rememberedRoom = game.save.multiplayer?.autoJoin
    ? (game.save.multiplayer.roomCode ?? '')
    : '';
  const bootRoom = invitedRoom || rememberedRoom;
  if (bootRoom) void game.joinMultiplayer(bootRoom);

  // ── Agent lifecycle ─────────────────────────────────────────────────────
  bridge = createAgentBridge({
    boot,
    onResume: () => {
      // Resuming after a completed round should offer the next round rather
      // than silently resume a finished game.
      if (game.mode.over) {
        game.restart(game.mode.modeId, { round: 1 });
      }
      game.save.progress.sessionsResumed += 1;
      game.start();
      hud.agentStatus('busy');
      hud.banner('Agent working — go', 1100);
    },
    onPause: () => {
      game.pause('agent');
      hud.agentStatus('idle');
    },
    onStatus: (state) => {
      hud.agentStatus(state);
      game.setAgentState(state);
    },
  });

  document.body.classList.toggle('embedded', boot.embedded);
  document.getElementById('boot-loader')?.remove();

  // Click-to-play: any click on the canvas locks the pointer and resumes.
  canvas.addEventListener('click', () => {
    if (!menu.visible) game.input.requestLock();
  });

  // Local debug controls — visible only when `?debug=1` is present. They drive
  // the same code path an editor extension uses, so the lifecycle can be
  // exercised without installing anything.
  if (new URLSearchParams(location.search).get('debug') === '1') {
    const bar = document.getElementById('debug-bar');
    bar?.classList.remove('hidden');
    document.getElementById('debug-busy')?.addEventListener('click', () => signalAgent('busy'));
    document.getElementById('debug-idle')?.addEventListener('click', () => signalAgent('idle'));
    document.getElementById('debug-clear')?.addEventListener('click', () => {
      store.clear();
      location.reload();
    });
  }

  // Persist on the way out so an editor closing the panel never loses a run.
  window.addEventListener('pagehide', () => game.persist(), { capture: true });

  // Exposed for the automated browser test and for manual poking in devtools.
  globalThis.thinkingBreak = { game, bridge, signalAgent, store };
} catch (err) {
  console.error('[Thinking Break] failed to start', err);
  showFatal(err instanceof Error ? err.message : String(err));
}
