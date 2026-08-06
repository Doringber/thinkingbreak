# Multiplayer

Thinking Break's arena is single-player by default and needs nothing extra to
work — that hasn't changed. Multiplayer is opt-in on top of it: everyone who
enters the same **room code** shares one live arena, sees each other move and
shoot, and sees whose coding agent is currently busy or idle.

This is the one part of the project that isn't purely static. GitHub Pages
can only serve files — it cannot hold open a live connection between
players — so multiplayer talks to a small real-time backend you provision
yourself: [Firebase Realtime Database](https://firebase.google.com/products/realtime-database),
on its free tier. Nothing else in the game (single-player, the extensions,
the installers) needs this, and if you never set it up, the Multiplayer panel
just says so and nothing else changes.

## Why Firebase, and what it costs you

- **Free tier is enough for a small team.** The Spark plan includes 100
  simultaneous connections and 10 GB/month of downloaded data, which a dozen
  people playing arena shooter for a few minutes at a time will not come
  close to.
- **No server code to write or host.** You create a project, flip two
  switches, paste a config object into one file. There is no Node process to
  keep running, unlike a self-hosted WebSocket relay.
- **The config is not a secret.** Firebase's client config (the values you
  paste into `firebaseConfig.js`) is meant to be public — access control is
  entirely the security rules on your database, set below. Still, use your
  own project's values, not anyone else's.

## Setup (about five minutes)

1. **Create a project.** Go to the
   [Firebase console](https://console.firebase.google.com/), click
   **Add project**, give it any name (e.g. `thinking-break-yourteam`), and
   skip Google Analytics — you don't need it.

2. **Enable Realtime Database.** In the left sidebar: **Build → Realtime
   Database → Create Database**. Pick any region. Start in **locked mode**
   (you'll paste real rules in a moment).

3. **Enable Anonymous authentication.** **Build → Authentication → Get
   started → Sign-in method → Anonymous → Enable.** This is what gives each
   browser tab an identity without anyone creating an account or typing a
   password.

4. **Get your web app config.** **Project settings (⚙) → General → Your
   apps → Add app → Web** (the `</>` icon). Name it anything. Firebase shows
   you a config object — copy it.

5. **Paste it into the game.** Open `fps/src/multiplayer/firebaseConfig.js`
   and fill in the four fields from step 4:

   ```js
   export const firebaseConfig = {
     apiKey: 'AIza...',
     authDomain: 'thinking-break-yourteam.firebaseapp.com',
     databaseURL: 'https://thinking-break-yourteam-default-rtdb.firebaseio.com',
     projectId: 'thinking-break-yourteam',
   };
   ```

6. **Set the security rules.** **Build → Realtime Database → Rules**, replace
   everything with the block below, and click **Publish**.

7. **Deploy.** Commit the filled-in config and push — the next Pages deploy
   ships it. (Or just run it locally with `npm run serve` to try it first.)

That's it. Open the game, go to **Multiplayer** in the pause menu, enter a
room code, and share that same code with your team.

## Security rules

```json
{
  "rules": {
    "rooms": {
      "$roomCode": {
        "players": {
          ".read": "auth != null",
          "$playerId": {
            ".write": "auth != null && auth.uid === $playerId"
          }
        },
        "hits": {
          "$targetId": {
            ".read": "auth.uid === $targetId",
            ".write": "auth != null"
          }
        }
      }
    },
    ".read": false,
    ".write": false
  }
}
```

What this actually allows, and why:

- Anyone signed in (anonymously — no account needed) can **read** every
  player in a room, which is how everyone sees everyone.
- A player can write **only their own** node — position, weapon, health,
  kills, agent state, all of it — and nobody else's. That includes health:
  there is no rule anywhere that lets one player write to another player's
  health field, on purpose. See the trust note below for why.
- `hits/{targetId}` is a room member's inbox: anyone can push a hit into it
  (`.write: auth != null`), but only the target themselves can read it back
  (`.read: auth.uid === $targetId`). The target's own client applies the
  damage to itself and deletes the entry once handled.
- Everything outside `rooms/` is unreadable and unwritable by clients.

## The trust model, plainly

There is no server arbitrating who actually hit whom — a shooter's own
browser decides "that was a hit" and signals it. The design specifically
avoids a shooter overwriting *another* player's health field for a real
reason: your health field is also being overwritten many times a second by
your own routine position updates, and letting two different clients race to
own it is precisely the kind of bug that only appears with a second browser
open. Instead, damage is a *signal*, and the person taking damage is always
the one who applies it to themselves.

This means a modified client could, in principle, ignore incoming damage or
report false hits. That is an acceptable trade for a team of colleagues
playing behind a private room code — which is exactly why the room-code
model was chosen over one global public room. It is not a fit for a
competitive or adversarial setting.

## Data this stores

Per room, only what's needed to render other players and show agent status:
position, aim, health, current weapon, alive/dead, kill count, agent
busy/idle, and an optional display name. Nothing about your code, your
prompts, or your agent's output ever goes anywhere near this. A player's node
is deleted the moment they leave or their tab closes (Firebase's
`onDisconnect` handles the ungraceful case), and hit-inbox entries are
deleted immediately after being applied — nothing accumulates.

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
  just a shared string; Firebase's own connection limits are the only cap.
