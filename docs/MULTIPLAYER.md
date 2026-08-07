# Multiplayer

Thinking Break's arena is single-player by default and needs nothing extra to
work — that hasn't changed. Multiplayer is opt-in on top of it: everyone who
enters the same **room code** shares one live arena, sees each other move and
shoot, and sees whose coding agent is currently busy or idle.

This is the one part of the project that isn't purely static. GitHub Pages
can only serve files — it cannot hold open a live connection between
players — so multiplayer talks to a small real-time backend you provision
yourself: [Supabase Realtime](https://supabase.com/realtime), on its free
tier. Nothing else in the game (single-player, the extensions, the
installers) needs this, and if you never set it up, the Multiplayer panel
just says so and nothing else changes.

## Why Supabase, and what it costs you

- **Free tier is enough for a small team.** The free plan includes 200
  concurrent Realtime connections and 5M messages/month, which a dozen
  people playing arena shooter for a few minutes at a time will not come
  close to.
- **No server code to write or host, and no auth setup either.** You create a
  project and paste two values into one file. There's no database schema, no
  security rules, and no sign-in method to enable — the game doesn't use
  Supabase Auth at all, just Realtime's presence and broadcast channels.
- **The config is not a secret.** Supabase's anon key is meant to be public —
  it's designed to ship to browsers, and this game's use of it (presence and
  broadcast on a public channel) needs no row-level security to lock down.
  Still, use your own project's values, not anyone else's.

## Setup (about two minutes)

1. **Create a project.** Go to the
   [Supabase dashboard](https://supabase.com/dashboard), click **New
   project**, give it any name (e.g. `thinking-break-yourteam`), and pick any
   region. You don't need to touch the database it provisions — this game
   only uses Realtime, not Postgres.

2. **Get your project URL and browser key.** In the new project: **Project
   Settings (⚙) → API Keys**. Copy the **Project URL**, plus *either* the
   **publishable** key (`sb_publishable_…`) or the legacy **anonymous /
   public** key (the long `eyJ…` JWT). Both are browser-safe.

   > **Never use a key marked SECRET** — `sb_secret_…` or the legacy
   > `service_role` JWT. Those bypass Row Level Security, and the deployed
   > page is readable by every visitor. `npm test` fails if one is committed,
   > but don't rely on that: the two sit one click apart in the dashboard. To
   > tell them apart, paste the JWT at [jwt.io](https://jwt.io) — the `role`
   > claim must read `anon`.

3. **Paste them into the game.** Open `fps/src/multiplayer/supabaseConfig.js`
   and fill in the two fields from step 2. The key is committed on purpose:
   it is public either way, since the deployed page hands it to every visitor,
   and committing it means the site works the moment it deploys with nothing
   else to configure. A test fails the build if a *secret* key is ever put
   there by mistake.

4. **For local development**, set it in devtools instead of editing the file,
   so a key can't ride along in a commit:

   ```js
   localStorage.setItem('thinking-break/supabase', JSON.stringify({
     url: 'https://yourproject.supabase.co',
     anonKey: 'eyJ…',
   }));
   ```

   Reload, and `npm run serve` behaves exactly like the deployed site. Undo
   with `localStorage.removeItem('thinking-break/supabase')`.

That's it — no database, no auth, no security rules to write. Open the game,
go to **Multiplayer** in the pause menu, and hit **Create a room**: it makes a
code, joins it, and hands you a link to paste in your team chat. Anyone who
opens that link lands in the same arena without typing anything.

## Hosting it somewhere your team can reach

GitHub Pages is the default, but it depends on Actions runners being available —
when that queue stalls, deploys stop. `netlify.toml` in the repo root is a
second, independent path that doesn't:

1. [app.netlify.com](https://app.netlify.com) → **Add new site → Import an
   existing project** → pick this repository.
2. Leave the build command empty; publish directory `.` (the file already says
   so). Deploy.
3. The game is at `https://<your-site>.netlify.app/fps/`.

Both can run at once — Netlify deploys from a push webhook, Pages from the
workflow. Cloudflare Pages works the same way: connect the repo, no build
command, output directory `/`.

One difference worth knowing: on Netlify the site sits at the domain root
rather than under `/thinkingbreak/`. The game doesn't care — every path it uses
is relative, and invite links are built from the address bar, so they point at
whichever host produced them. The absolute `github.io` URLs elsewhere in the
repo (the extensions' default `gameUrl`, the install scripts) still point at
Pages; change those only if a new host becomes the canonical one.

## Getting a team in without anyone typing a code

Typing a room code is one more thing to get wrong, on every machine. Three
ways to skip it, in increasing order of "set it once and forget":

1. **Invite link.** Once you're in a room, the Multiplayer panel shows
   **Copy invite link** — a URL ending in `?room=YOURCODE`. Paste it in your
   team chat; anyone who opens it joins that room on load, no typing. (The
   link deliberately drops `embed`/`agent`/`host`/`debug` params, so a link
   copied from inside an editor panel still opens as a normal playable page
   for everyone else.)

2. **Extension setting.** Set `thinkingBreak.roomCode` (or
   `thinkingBreakCursor.roomCode` / `thinkingBreakCodex.roomCode`) to your
   team's code. Every time the panel opens on an agent break, it joins that
   room automatically. Put it in **workspace settings** — or push it through
   your org's settings sync — and the whole team is enrolled at once, with
   nobody configuring anything individually.

3. **Nothing at all, after the first time.** Whichever way you got in, the
   room is remembered locally and rejoined on the next open, so an agent
   break two minutes later puts you straight back with your teammates.

An invite link wins over the remembered room, so sending someone a link always
moves them to that room rather than silently keeping them in an old one.

## How it works

Each room is one Supabase Realtime channel, named after the room code. Two
of that channel's features do all the work:

- **Presence** is the roster. Each client `track()`s its own snapshot
  (position, aim, health, weapon, agent state, kills, name) under a
  client-generated id; every other client's `presenceState()` updates
  automatically, which is how everyone sees everyone. When a tab closes or
  the connection drops, Supabase removes that presence entry for us — no
  manual disconnect-cleanup code needed.
- **Broadcast** is how hits are signalled. A shooter sends an ephemeral
  message addressed to the target's id; broadcasts are never stored
  server-side and every subscriber receives every one, filtered client-side
  to messages addressed to them. The target's own client applies the damage
  to itself.

There's no Supabase Auth involved — each client generates its own random id on
join (`crypto.randomUUID()`, falling back to `getRandomValues` where that isn't
available, such as a page served over plain HTTP on a LAN address). That's
enough identity for a trusted-team room-code model, and it skips a whole setup
step Firebase-style backends would need.

The Supabase client itself is fetched from a CDN on first Join —
`cdn.jsdelivr.net`, falling back to `esm.sh` if that's blocked, since corporate
networks often allowlist one and not the other. If both are unreachable the
panel says so explicitly rather than looking like multiplayer is broken, and
pressing Join again retries. Nothing is fetched at all until someone joins a
room, so single-player never touches either host.

## The trust model, plainly

There is no server arbitrating who actually hit whom — a shooter's own
browser decides "that was a hit" and signals it. The design specifically
avoids a shooter writing to *another* player's health directly — for a real
reason: your health is also being republished many times a second by your
own routine presence updates, and letting two different clients race to own
it is precisely the kind of bug that only appears with a second browser
open. Instead, damage is a *signal* sent over broadcast, and the person
taking damage is always the one who applies it to themselves.

This means a modified client could, in principle, ignore incoming damage or
report false hits. That is an acceptable trade for a team of colleagues
playing behind a private room code — which is exactly why the room-code
model was chosen over one global public room. It is not a fit for a
competitive or adversarial setting.

The channel itself is also public in the Supabase sense — anyone who knows
(or guesses) the room code's channel name can join it, the same practical
security level a shared room code always has. Nothing sensitive is ever
put on it; see below.

## Data this stores

Per room, only what's needed to render other players and show agent status:
position, aim, health, current weapon, alive/dead, kill count, agent
busy/idle, and an optional display name. Nothing about your code, your
prompts, or your agent's output ever goes anywhere near this. A player
disappears from everyone's roster the moment they leave or their tab closes
(Supabase Presence handles the ungraceful case automatically), and hit
broadcasts are never persisted anywhere — nothing accumulates.

Locally, only the room code itself is remembered (in the same
`thinking-break/save` key everything else uses), so you don't have to retype
it every time the game reopens.

## Known limitations

- **No server-authoritative hit detection.** See the trust model above.
- **Crouch height isn't networked.** Every remote player is rendered and
  hit-tested as if standing; crouching to duck a shot only works locally
  against bots today.
- **Bot-wave and mode progression treat a PvP kill like a bot kill.** Killing
  a teammate in Survival mode advances your wave the same as killing a bot.
  Simple, and consistent, but worth knowing.
- **No matchmaking, no room list, no room limit enforcement.** A room code is
  just a shared channel name; Supabase's own connection limits are the only
  cap.
