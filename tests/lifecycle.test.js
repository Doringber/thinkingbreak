import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  AGENT_BUSY, AGENT_IDLE, createAgentStateMachine, normalizeEvent,
} from '../fps/src/lifecycle/agentState.js';
import { readBootConfig } from '../fps/src/lifecycle/bridge.js';

/** Machine with counters, so "exactly once" is checkable. */
function harness(opts = {}) {
  const calls = { resume: 0, pause: 0, status: [] };
  const machine = createAgentStateMachine({
    onResume: () => calls.resume++,
    onPause: () => calls.pause++,
    onStatus: (s) => calls.status.push(s),
    idleGraceMs: 0,
    ...opts,
  });
  return { calls, machine };
}

test('event names from every agent map onto busy or idle', () => {
  for (const name of ['busy', 'BUSY', ' start ', 'working', 'thinking', 'PreToolUse']) {
    assert.equal(normalizeEvent(name), AGENT_BUSY, `${name} should mean busy`);
  }
  for (const name of ['idle', 'Stop', 'done', 'complete', 'finish', 'sessionEnd', 'SubagentStop']) {
    assert.equal(normalizeEvent(name), AGENT_IDLE, `${name} should mean idle`);
  }
  for (const name of ['', 'nonsense', null, undefined, 42, {}]) {
    assert.equal(normalizeEvent(name), null);
  }
});

test('idle to busy resumes exactly once', () => {
  const { calls, machine } = harness();
  assert.equal(machine.handle('busy'), true);
  assert.equal(calls.resume, 1);
  assert.equal(machine.state, AGENT_BUSY);
});

test('repeated busy events never restart the game', () => {
  const { calls, machine } = harness();
  for (let i = 0; i < 50; i++) machine.handle('busy');
  assert.equal(calls.resume, 1, 'one resume for fifty busy events');
  assert.equal(calls.pause, 0);
  assert.equal(machine.transitions, 1);
  assert.equal(calls.status.length, 50, 'but the status label refreshes each time');
});

test('busy to idle pauses exactly once', () => {
  const { calls, machine } = harness();
  machine.handle('busy');
  assert.equal(machine.handle('stop'), true);
  assert.equal(calls.pause, 1);
  assert.equal(machine.state, AGENT_IDLE);
});

test('repeated idle events do not pause repeatedly', () => {
  const { calls, machine } = harness();
  machine.handle('busy');
  for (let i = 0; i < 20; i++) machine.handle('idle');
  assert.equal(calls.pause, 1);
  assert.equal(machine.transitions, 2);
});

test('a busy/idle storm produces one transition per real edge', () => {
  const { calls, machine } = harness();
  const script = ['busy', 'busy', 'busy', 'idle', 'idle', 'busy', 'busy', 'idle', 'busy'];
  for (const event of script) machine.handle(event);
  assert.equal(calls.resume, 3);
  assert.equal(calls.pause, 2);
  assert.equal(machine.state, AGENT_BUSY);
  assert.equal(machine.transitions, 5);
});

test('an idle inside the grace window is deferred, and a busy cancels it', async () => {
  const { calls, machine } = harness({ idleGraceMs: 60 });
  machine.handle('busy');
  machine.handle('idle');
  assert.equal(calls.pause, 0, 'not paused yet');
  assert.equal(machine.hasPendingIdle, true);

  machine.handle('busy');
  assert.equal(machine.hasPendingIdle, false, 'the follow-up busy cancelled it');

  await sleep(120);
  assert.equal(calls.pause, 0, 'the deferred pause never fired');
  assert.equal(calls.resume, 1, 'and the game was never restarted');
  machine.dispose();
});

test('a deferred idle does fire when no busy follows', async () => {
  const { calls, machine } = harness({ idleGraceMs: 40 });
  machine.handle('busy');
  machine.handle('idle');
  assert.equal(calls.pause, 0);
  await sleep(120);
  assert.equal(calls.pause, 1);
  assert.equal(machine.state, AGENT_IDLE);
  machine.dispose();
});

test('forceIdle bypasses the grace window', () => {
  const { calls, machine } = harness({ idleGraceMs: 10_000 });
  machine.handle('busy');
  machine.forceIdle();
  assert.equal(calls.pause, 1);
  assert.equal(machine.state, AGENT_IDLE);
  machine.dispose();
});

test('unknown events are ignored entirely', () => {
  const { calls, machine } = harness();
  assert.equal(machine.handle('reticulating-splines'), false);
  assert.equal(calls.resume + calls.pause, 0);
  assert.equal(machine.state, AGENT_IDLE);
});

test('a disposed machine stops firing timers and callbacks', async () => {
  const { calls, machine } = harness({ idleGraceMs: 30 });
  machine.handle('busy');
  machine.handle('idle');
  machine.dispose();
  await sleep(80);
  assert.equal(calls.pause, 0, 'the pending idle was cancelled by dispose');
  assert.equal(machine.handle('busy'), false, 'and further events are refused');
});

test('boot config: a standalone visitor starts playing immediately', () => {
  const boot = readBootConfig('');
  assert.equal(boot.embedded, false);
  assert.equal(boot.initialState, AGENT_BUSY);
  assert.equal(boot.host, 'browser');
});

test('boot config: an embedded panel waits for the host', () => {
  const boot = readBootConfig('?embed=1');
  assert.equal(boot.embedded, true);
  assert.equal(boot.initialState, AGENT_IDLE);
  assert.equal(boot.host, 'editor');
});

test('boot config: an explicit agent parameter wins', () => {
  assert.equal(readBootConfig('?embed=1&agent=busy').initialState, AGENT_BUSY);
  assert.equal(readBootConfig('?agent=idle').initialState, AGENT_IDLE);
  assert.equal(readBootConfig('?agent=garbage').initialState, AGENT_BUSY, 'garbage falls back to the default');
});
