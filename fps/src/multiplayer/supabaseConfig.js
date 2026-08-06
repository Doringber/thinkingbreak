// Thinking Break — Supabase project configuration.
//
// Nothing is committed here on purpose. The deploy workflow writes these values
// in from repository secrets (`SUPABASE_URL` / `SUPABASE_ANON_KEY`) on its way
// to Pages, so no key lives in the repository or its history.
//
// Be clear about what that does and does not buy you. It keeps keys out of git,
// off the public source tree, and rotatable without a commit. It cannot make
// the key *secret*: a static site has to hand the browser something to connect
// with, so anyone can still read it from the deployed page. That is fine — this
// is precisely the key Supabase designs to be published, and the game only ever
// uses public Realtime channels with no database access. It is also exactly why
// a key Supabase marks **secret** (`sb_secret_…`, or a legacy `service_role`
// JWT) must never come near this file: those bypass Row Level Security, and the
// deploy refuses to ship one.
//
// `anonKey` accepts either browser-safe key: the publishable key
// (`sb_publishable_…`) or the legacy anonymous JWT (`eyJ…`, with `role: anon`).

// Substituted at deploy time. Left as placeholders in a fresh clone, which
// simply means multiplayer is switched off.
const DEPLOY_INJECTED = {
  url: '__SUPABASE_URL__',
  anonKey: '__SUPABASE_ANON_KEY__',
};

const wasSubstituted = (value) =>
  typeof value === 'string' && value.length > 0 && !value.startsWith('__SUPABASE');

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

export const supabaseConfig = localOverride() ?? {
  url: wasSubstituted(DEPLOY_INJECTED.url) ? DEPLOY_INJECTED.url : '',
  anonKey: wasSubstituted(DEPLOY_INJECTED.anonKey) ? DEPLOY_INJECTED.anonKey : '',
};

/** True once the fields multiplayer actually needs are filled in. */
export function isMultiplayerConfigured(config = supabaseConfig) {
  return Boolean(config?.url && config?.anonKey);
}
