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

2. **Get your project URL and anon key.** In the new project: **Project
   Settings (⚙) → API**. Copy the **Project URL** and the **anon public**
   key.

3. **Paste them into the game.** Open `fps/src/multiplayer/supabaseConfig.js`
   and fill in the two fields from step 2:

   ```js
   export const supabaseConfig = {
     url: 'https://yourproject.supabase.co',
     anonKey: 'eyJ...',
   };
   ```

4. **Deploy.** Commit the filled-in config and push — the next Pages deploy
   ships it. (Or just run it locally with `npm run serve` to try it first.)

That's it — no database, no auth, no security rules to write. Open the game,
go to **Multiplayer** in the pause menu, enter a room code, and share that
same code with your team.

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

There's no Supabase Auth involved — each client generates its own random id
with `crypto.randomUUID()` on join. That's enough identity for a trusted-team
room-code model, and it skips a whole setup step Firebase-style backends
would need.

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
