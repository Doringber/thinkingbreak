// Thinking Break — Firebase project configuration.
//
// Multiplayer is opt-in and requires your own free Firebase project; the game
// itself ships with none configured, and stays fully playable offline either
// way. See docs/MULTIPLAYER.md for the five-minute setup (create a project,
// enable Realtime Database + Anonymous auth, paste the values below, deploy
// the security rules from that doc).
//
// These values are meant to be public — Firebase's client config is not a
// secret; access is controlled by the security rules on the database, not by
// hiding this object. Still, only fill in your own project's values, never
// someone else's.

export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  databaseURL: '',
  projectId: '',
};

/** True once the fields multiplayer actually needs are filled in. */
export function isMultiplayerConfigured(config = firebaseConfig) {
  return Boolean(config?.apiKey && config?.databaseURL && config?.projectId);
}
