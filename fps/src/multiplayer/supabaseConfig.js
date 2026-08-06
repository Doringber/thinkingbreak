// Thinking Break — Supabase project configuration.
//
// Multiplayer is opt-in and requires your own free Supabase project; the game
// itself ships with none configured, and stays fully playable offline either
// way. See docs/MULTIPLAYER.md for the two-minute setup (create a project,
// paste the URL and anon key below — no auth or database setup needed).
//
// These values are meant to be public — Supabase's anon key is designed to be
// shipped to browsers; it only grants what your project's policies allow, and
// this game's use of it (Realtime presence/broadcast on public channels)
// needs no server-side access control at all. Still, only fill in your own
// project's values, never someone else's.

export const supabaseConfig = {
  url: 'https://nrgzktqvbkyiuywraanq.supabase.co',
  anonKey: 'sb_publishable_YhBusXcfc7iDpMjZKCUsXA_srj-aqvZ',
};

/** True once the fields multiplayer actually needs are filled in. */
export function isMultiplayerConfigured(config = supabaseConfig) {
  return Boolean(config?.url && config?.anonKey);
}
