import { md5 } from "./md5.js";
import { logError, logWarn } from "./log.js";

/**
 * Constant-time string equality to reduce timing side-channel leakage.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function secureEq(a, b) {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLen; i++) {
    const av = i < aBytes.length ? aBytes[i] : 0;
    const bv = i < bBytes.length ? bBytes[i] : 0;
    diff |= av ^ bv;
  }
  return diff === 0;
}

/**
 * Validates the given api_key per the Fever API authentication protocol.
 * The client sends api_key = md5("{email}:{password}").
 *
 * @param {string|undefined} apiKey
 * @param {Record<string, unknown>} env
 * @returns {boolean}
 */
export function isAuthenticated(apiKey, env) {
  const rawPassword = env.CURRENT_FEVER_PASSWORD;
  if (rawPassword === undefined || rawPassword === null) {
    logError("CURRENT_FEVER_PASSWORD not configured — denying all requests");
    return false;
  }
  const password = String(rawPassword);

  let email = env.CURRENT_FEVER_EMAIL;
  if (email === undefined || email === null) {
    logWarn("CURRENT_FEVER_EMAIL not configured — defaulting to 'admin'");
    email = "admin";
  }
  email = String(email);

  if (apiKey !== undefined && apiKey !== null) {
    // Compute md5("{email}:{password}") per Fever API spec
    const hash = md5(`${email}:${password}`);
    return secureEq(apiKey, hash);
  }

  logWarn("auth: authentication failed — no api_key provided");
  return false;
}
