// Thinking Break — Supabase project configuration.
//
// Multiplayer is opt-in and requires your own free Supabase project; the game
// itself ships with none configured, and stays fully playable offline either
// way. See docs/MULTIPLAYER.md for the two-minute setup (create a project,
// paste the URL and anon key below — no auth or database setup needed).
//
// `anonKey` takes either of the two keys Supabase labels for browser use:
//
//   • the **publishable** key (`sb_publishable_…`), or
//   • the legacy **anonymous / public** key (the long `eyJ…` JWT).
//
// Either is fine. Both are meant to be public — they're designed to ship to
// browsers, and this game's use of them (Realtime presence and broadcast on
// public channels) needs no server-side access control at all.
//
// Never put a key Supabase marks **secret** here — `sb_secret_…` or the legacy
// `service_role` key. Those bypass Row Level Security entirely, and this file
// is served to every visitor as plain text, so pasting one publishes full
// admin access to your project. Only ever fill in your own project's values.

export const supabaseConfig = {
  url: 'https://nrgzktqvbkyiuywraanq.supabase.co',
  anonKey: 'sb_publishable_YhBusXcfc7iDpMjZKCUsXA_srj-aqvZ',
};

/** True once the fields multiplayer actually needs are filled in. */
export function isMultiplayerConfigured(config = supabaseConfig) {
  return Boolean(config?.url && config?.anonKey);
}
