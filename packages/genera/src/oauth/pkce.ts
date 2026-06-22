/**
 * PKCE (RFC 7636) helpers — isomorphic via Web Crypto (`globalThis.crypto`).
 * S256 only; no plain method (it defeats the purpose).
 */

/** URL-safe base64 without padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A random code verifier — 86 unreserved chars (from 64 random bytes), within RFC's 43–128. */
export function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(64)));
}

/** S256 code challenge = BASE64URL(SHA-256(verifier)). */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** A random CSRF `state` value to verify when the redirect returns. */
export function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}
