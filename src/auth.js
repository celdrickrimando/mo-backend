/**
 * Server-side access control for Mo.
 *
 * The extension's popup gets a Google OAuth access token via
 * chrome.identity.launchWebAuthFlow() (works across Chrome, Brave, and
 * other Chromium browsers — see popup.js's WEB_CLIENT_ID) and sends it to
 * the backend on every request. Anyone who installs the extension (or just
 * calls the backend directly with curl/Postman and any valid Google access
 * token) could use it before this file existed — there was no check on WHO
 * the signed-in user actually is. That's not something the extension code
 * can fix by itself: popup.js and manifest.json both ship in the unpacked
 * extension, so a user can edit either one locally and bypass any
 * client-side check. The only place an allowlist actually holds is here,
 * on the backend, where the person calling the API can't edit the source.
 *
 * verifyAccessToken() calls Google's tokeninfo endpoint with the token the
 * client sent, and trusts what GOOGLE says the token is good for — not
 * anything the client claims about itself. Three things are checked:
 *
 *   1. The token is actually valid and unexpired (tokeninfo simply 400s
 *      for anything else).
 *   2. `aud` (the OAuth client the token was issued to) matches Mo's own
 *      Web application client_id — the one popup.js's WEB_CLIENT_ID uses
 *      to request the token via launchWebAuthFlow. Without this, a token
 *      that legitimately has email scope but was issued to some OTHER app
 *      could be replayed here.
 *   3. The account's email is verified and is either in the explicit
 *      ALLOWED_EMAILS allowlist or ends in @ALLOWED_EMAIL_DOMAIN.
 *
 * This requires the token to carry email scope, which is why popup.js's
 * OAUTH_SCOPES includes userinfo.email.
 */

const CLIENT_ID =
  process.env.GOOGLE_OAUTH_CLIENT_ID ||
  "269390370504-gmdl1a28ghlcg385r93cd8caallg4m7f.apps.googleusercontent.com";

const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || "dlsu.edu.ph")
  .trim()
  .toLowerCase()
  .replace(/^@/, "");

const ALLOWED_EMAILS = new Set(
  (process.env.ALLOWED_EMAILS || "celdrickrimando@gmail.com")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

// Short-lived cache so a popup session that fires /check then /dismiss-issue
// seconds later doesn't round-trip to Google's tokeninfo endpoint twice for
// the same still-valid token. Keyed by the raw token string; entries expire
// well before a real Google access token would (~1 hour), so a stale cache
// entry never outlives the token itself.
const verifiedCache = new Map(); // accessToken -> { email, expiresAt }
const CACHE_TTL_MS = 4 * 60 * 1000;

// Without this, expired entries were only ever skipped on read, never
// actually removed — the Map grows forever over the server's lifetime,
// since a fresh Google access token (a new Map key) shows up roughly
// every time each signed-in user's token refreshes. A periodic sweep
// keeps memory bounded by the number of DISTINCT tokens seen in the last
// CACHE_TTL_MS, not the total ever seen since the process started.
const CACHE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of verifiedCache) {
    if (entry.expiresAt <= now) verifiedCache.delete(token);
  }
}, CACHE_SWEEP_INTERVAL_MS).unref(); // .unref() so this timer alone doesn't keep the process alive

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isAllowedEmail(email) {
  if (!email) return false;
  const lower = email.toLowerCase();
  if (ALLOWED_EMAILS.has(lower)) return true;
  const domain = lower.split("@")[1];
  return domain === ALLOWED_DOMAIN;
}

/**
 * Verifies a Google OAuth access token and enforces the allowlist.
 * Returns the verified email on success, or throws an Error with a
 * `.status` (400/401/403) set for the caller to relay to the client.
 */
export async function verifyAccessToken(accessToken) {
  if (!accessToken || typeof accessToken !== "string") {
    throw httpError(400, "accessToken is required.");
  }

  const cached = verifiedCache.get(accessToken);
  if (cached) {
    if (cached.expiresAt > Date.now()) return cached.email;
    verifiedCache.delete(accessToken); // stale — clean up now rather than waiting for the next sweep
  }

  let info;
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
    );
    if (!res.ok) {
      // tokeninfo 400s for expired/invalid/revoked tokens.
      throw httpError(401, "Your sign-in has expired. Please sign in again.");
    }
    info = await res.json();
  } catch (err) {
    if (err.status) throw err;
    throw httpError(401, "Could not verify your sign-in with Google. Please try again.");
  }

  if (info.aud !== CLIENT_ID) {
    throw httpError(401, "This sign-in token wasn't issued for Mo. Please sign in again.");
  }

  if (info.email_verified !== "true" && info.email_verified !== true) {
    throw httpError(403, "Your Google account's email address isn't verified.");
  }

  if (!isAllowedEmail(info.email)) {
    throw httpError(
      403,
      `Mo is restricted to @${ALLOWED_DOMAIN} accounts. Please sign in with your DLSU Google account.`
    );
  }

  verifiedCache.set(accessToken, { email: info.email, expiresAt: Date.now() + CACHE_TTL_MS });
  return info.email;
}

/**
 * Express middleware: verifies req.body.accessToken and enforces the
 * allowlist before the route handler runs. On success, sets req.userEmail.
 * Mount this on every route that accepts an accessToken and acts on the
 * user's behalf.
 */
export function requireAllowedUser() {
  return async (req, res, next) => {
    try {
      req.userEmail = await verifyAccessToken(req.body?.accessToken);
      next();
    } catch (err) {
      res.status(err.status || 401).json({ error: err.message });
    }
  };
}
