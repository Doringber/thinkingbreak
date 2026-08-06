# Migration and attribution

Thinking Break was built by taking the agent-lifecycle architecture of
[`Doringber/creativity`](https://github.com/Doringber/creativity) — the
"Pango Snack" project — as its foundation, and replacing everything else.

This document records exactly which components came across, how each was
changed, and what is new. `Doringber/creativity` was treated as read-only
reference throughout; no commit was made to it.

## Licensing

At the time of migration `Doringber/creativity` carried **no `LICENSE` file**.
Both repositories are owned by the same author (Dor Ingber), who directed this
migration, so reuse is authorised by the copyright holder rather than by a
public licence grant. Copyright notices and the upstream credit chain are
preserved regardless:

- `Doringber/creativity`'s installation page credits
  [`ofershap/context-snack`](https://github.com/ofershap/context-snack) for the
  original idea. That credit is carried forward in `LICENSE` and this document.
- Thinking Break is released under the **MIT Licence**, with an attribution
  note appended to `LICENSE`.
- Every file containing adapted code names its origin in a header comment.

### Third-party dependencies

**None at runtime.** The game ships no libraries — no Three.js, no framework,
no CDN script, no font, no audio file, no texture. The only development
dependencies are `typescript` and the `@types/node` / `@types/vscode` type
packages (all Apache-2.0 / MIT), used solely to compile the editor extensions.

`tools/verify-paths.js` enforces that no ES module in `fps/src/` uses a bare
specifier, which is what keeps the runtime dependency count at zero.

## What was copied or adapted

| Thinking Break | Adapted from `creativity` | What changed |
|---|---|---|
| `extensions/shared/gamePanel.ts` | `snack-shared/openGamePanel.ts`, `pango-snack/src/gamePanel.ts` | **Substantially rewritten.** The original opened the game in VS Code's Simple Browser and closed the panel on idle, which discarded the session and made every task a cold start. Thinking Break hosts the game in a webview panel it owns, keeps the panel alive across agent turns, and relays busy/idle to the page over `postMessage` — so a resume continues the run instead of reloading it. Kept: the wide-layout command sequence, the `openExternal` escape hatch, the single-panel lock file, and the stale-lock timeout. Added: message relay, `preserveFocus`, `returnFocusToEditor`, PID in the lock, Simple Browser demoted to an opt-in fallback. |
| `extensions/shared/agentWatcher.ts` | The `fs.watch` blocks duplicated in all three `*/src/extension.ts` | **Extracted and hardened.** One implementation instead of three copies. Added: de-duplicated busy/idle edges (an agent emitting busy on every tool call no longer re-triggers the open path), a debounce so an idle between two tool calls does not pause the game, a stale-busy timeout for agents that die mid-task, a low-frequency poll because `fs.watch` misses events on some filesystems, and validation of the parsed JSON. |
| `extensions/shared/activation.ts` | The common body of the three `activate()` functions | **New file, same responsibilities.** Status bar, commands, config reads and watcher wiring, written once and parameterised by an `AgentIntegration` descriptor. |
| `extensions/claude/src/extension.ts` | `pango-snack/src/extension.ts` | Hook wiring kept in shape. Changed: the settings merge is non-destructive (previous Thinking Break entries are removed and re-added rather than accumulating, and a user's own hooks are never dropped); an unparseable `settings.json` is backed up instead of overwritten; `UserPromptSubmit` and `SubagentStop` added. |
| `extensions/cursor/src/extension.ts` | `cursor-pango-snack/src/extension.ts` | Same hook events (`beforeSubmitPrompt`, `stop`, `sessionEnd`), plus `beforeShellExecution`. Changed: the hook script is bash rather than an ESM Node script (one fewer runtime assumption); a hook the user wrote themselves is never overwritten. |
| `extensions/codex/src/extension.ts` | `codex-pango-snack/src/extension.ts` | **Three-layer detection preserved** — config hooks, shell wrapper, `pgrep` poll — because no single layer covers every Codex invocation. Changed: the shell-rc patch is fenced with begin/end markers so `uninstall.sh` can remove it cleanly and re-running never appends a second copy; the wrapper propagates the exit status; `execFile` replaces `execSync` so polling never blocks the extension host; polling is a setting. |
| `install.sh` | `install.sh` | Same download → build → package → install flow, and the same IDE-CLI resolution (the binary on `PATH` may be a wrapper that rejects `--install-extension`). Changed: names and URLs; a shared-source sync step; Node 18+; clearer failure messages. |
| `install-terminal.sh` | `install-terminal.sh` | Same design — per-agent hook wiring in Python, a polling watcher, a `launchd` LaunchAgent. Changed: the watcher now **focuses** an already-open game window instead of closing and reopening the tab, so the session survives between tasks; the Claude hook merge is non-destructive; unparseable settings files are backed up. |
| `index.html`, `site/install.css` | `install.html` | **Visual language carried over, content rewritten.** Kept: the design tokens (`--bg`, `--surface`, `--accent`, `--muted`, …), the light/dark theme system with a manual toggle, the animated dot-grid backdrop, the terminal block with copy button, the rounded card grid with hook pills, the numbered "what the installer does" list, and the overall typography and spacing. Changed: Thinking Break branding, and new sections for the lifecycle, the game, controls, privacy and uninstall. |
| `site/install.js` | The inline `<script>` in `install.html` | Theme toggle and copy button, extracted to a file. Added a selection fallback when the clipboard API is blocked. |
| Busy/idle contract | The `{"busy":bool,"at":ts}` state file | **Kept as the interface**, so hooks installed by either project have the same shape. `at` is now accepted in either seconds or milliseconds. |
| `tools/make_icon.py` | `tools/make_icons.py` | Same idea — a dependency-free PNG writer using only `zlib` and `struct`. The artwork is new. |
| `.nojekyll` | `.nojekyll` | Unchanged in purpose. |

## What was written from scratch

Everything below is original to this repository.

**The game.** All of `fps/`:

- `core/renderer.js` — instanced-box WebGL2 renderer, ~8 KB, one draw call for
  the world.
- `core/math.js` — matrices, view/projection, frustum extraction, seeded PRNG.
- `core/input.js` — keyboard, mouse, pointer lock with `unadjustedMovement`.
- `core/audio.js` — every sound synthesised with Web Audio primitives, so
  nothing is downloaded and nothing is licensed.
- `core/storage.js` — versioned save with a migration chain and defensive
  normalisation.
- `game/arena.js` — *Cache Line*, an original 48 × 48 arena.
- `game/collision.js` — swept-AABB resolution and slab raycasting.
- `game/player.js` — arcade movement: air control, coyote time, jump buffering,
  sprint, crouch, slide.
- `game/bots.js` — navmesh-free bot AI with stuck recovery.
- `game/weapons.js` — three original weapons and all firing rules.
- `game/modes.js` — five modes and the scoring model.
- `game/effects.js` — pooled particles, tracers and decals.
- `game/game.js` — the orchestrator and its single render loop.
- `ui/hud.js`, `ui/menu.js` — HUD and overlay.
- `lifecycle/agentState.js`, `lifecycle/bridge.js` — the in-page half of the
  lifecycle, which has no counterpart in `creativity` (there, the *panel*
  opened and closed; here, the *game* pauses and resumes).

**Tooling.** `tools/serve.js` (base-path-aware dev server), `tools/build.js`,
`tools/build-extensions.js`, `tools/verify-paths.js`, `tools/screenshots.js`.

**Tests.** All of `tests/` — 100 tests over weapons, modes, persistence,
lifecycle and world simulation. `creativity` had one ad-hoc script
(`tools/verify_fever.js`) and no test suite.

**Infrastructure.** `.github/workflows/pages.yml`, `.github/workflows/ci.yml`,
`uninstall.sh`, `LICENSE`, `README.md`, this file.

**Branding.** The crosshair mark (`assets/favicon.svg`,
`extensions/claude/icon.png`) and the Thinking Break name and voice.

## What was deliberately left behind

| Not migrated | Why |
|---|---|
| `js/game.js`, `js/data.js`, `js/audio.js` | The AR catch-'em-up game. Thinking Break is a different genre with nothing to reuse. |
| `assets/sprites/`, `assets/weapons/`, `icons/*.fbx`, `css/*.gltf`, `css/*.fbx` | ~11 MB of third-party 3D models and sprite art of unclear provenance. Thinking Break uses procedural geometry and no downloaded assets — which also keeps the licensing clean. |
| `css/style.css` | Styled the AR game's screens; no overlap. |
| `manifest.webmanifest`, `sw.js` | The PWA/offline shell for a mobile camera game. A new, minimal manifest was written for the game page; the service worker was dropped as unnecessary for a static page opened by an editor. |
| `android/` | A WebView wrapper for the Android app. Out of scope. |
| `netlify.toml` | Netlify config with camera/gyroscope permissions headers. Thinking Break deploys to GitHub Pages and needs no sensor permissions. |
| `tools/verify_fever.js` | A one-off check for a mechanic that does not exist here. |
| Hebrew/RTL UI | The source game's interface language. Thinking Break's UI is English/LTR. |

## Renaming reference

| Old | New |
|---|---|
| Pango Snack / Pango GO | Thinking Break |
| `pango-snack`, `cursor-pango-snack`, `codex-pango-snack` | `thinking-break`, `thinking-break-cursor`, `thinking-break-codex` |
| `pangoSnack.*`, `cursorPangoSnack.*`, `codexPangoSnack.*` | `thinkingBreak.*`, `thinkingBreakCursor.*`, `thinkingBreakCodex.*` |
| `~/.pango-snack/` | `~/.thinking-break/` |
| `~/.claude/pango-snack/` | `~/.claude/thinking-break/` |
| `~/.cursor/pango-snack/` | `~/.cursor/thinking-break/` |
| `~/.codex/pango-snack/` | `~/.codex/thinking-break/` |
| `com.doringber.pango-snack-terminal` | `com.doringber.thinking-break` |
| `https://doringber.github.io/creativity/` | `https://doringber.github.io/thinkingbreak/` |
| `https://main.d2suajt6dnp50j.amplifyapp.com/index.html` | `https://doringber.github.io/thinkingbreak/fps/` |
| `# pango-snack-codex` | `# >>> thinking-break-codex >>>` … `# <<< thinking-break-codex <<<` |
| `pango-theme` (localStorage) | `thinking-break/theme` |
| `pangogo.name`, `pangogo.*` (localStorage) | `thinking-break/save` |

`tools/verify-paths.js` runs on every build and in CI, and fails if any of the
old names, URLs or paths reappear in live code. Attribution comments and the
attribution documents are exempt, because naming the source is required.
