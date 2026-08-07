// Thinking Break — Supabase project configuration.
//
// Multiplayer is opt-in and needs a Supabase project; single-player never
// touches any of this and works with none configured.
//
// The key below is deliberately public. A static site has to hand the browser
// something to connect with, so the deployed page exposes it to every visitor
// no matter where it is stored — hiding it in a secret store would change
// nothing about that. This is exactly the key Supabase designs to be published,
// and the game only uses public Realtime channels with no database access.
//
// `anonKey` accepts either browser-safe key: the publishable key
// (`sb_publishable_…`) or the legacy anonymous JWT (`eyJ…`, `role: anon`).
//
// What must NEVER go here is a key Supabase marks **secret** — `sb_secret_…` or
// a legacy `service_role` JWT. Those bypass Row Level Security, and this file is
// served as plain text. They sit one click away from the safe ones in the
// dashboard, so a test asserts the committed key is not one of them.

// Committed on purpose. This key is public either way — the deployed page hands
// it to every visitor, which is what a browser key is for — so keeping it here
// buys zero-setup deploys anywhere the repo is hosted, at no real cost. A test
// (`tests/multiplayer.test.js`) fails the build if a *secret* key is ever put
// here by mistake, since those two sit one click apart in the dashboard.
const COMMITTED = {
  url: 'https://nrgzktqvbkyiuywraanq.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5yZ3prdHF2Ymt5aXV5d3JhYW5xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwMjUyODAsImV4cCI6MjEwMTYwMTI4MH0._k2VvlPYZsCyiMbZFSyCYJuKYvslq87QIfOXWhS6MfA',
};

// Local development and forks: set this once in devtools rather than editing
// this file, so a key cannot ride along in a commit by accident.
//
//   localStorage.setItem('thinking-break/supabase', JSON.stringify({
//     url: 'https://yourproject.supabase.co',
//     anonKey: 'eyJ…',
//   }));
//
// Then reload. Clear it with `localStorage.removeItem('thinking-break/supabase')`.
export const LOCAL_CONFIG_KEY = 'thinking-break/supabase';

function localOverride() {
  let raw;
  try {
    raw = globalThis.localStorage?.getItem(LOCAL_CONFIG_KEY);
  } catch {
    return null; // storage disabled (private mode, sandboxed webview)
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.url !== 'string' || typeof parsed?.anonKey !== 'string') return null;
    if (!parsed.url || !parsed.anonKey) return null;
    return { url: parsed.url, anonKey: parsed.anonKey };
  } catch {
    return null; // malformed JSON — stay unconfigured rather than half-configured
  }
}

export const supabaseConfig = localOverride() ?? COMMITTED;
