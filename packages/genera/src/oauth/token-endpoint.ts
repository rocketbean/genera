import { AuthError } from "../errors";
import type { OAuthTokenResponse, TokenSet } from "./types";

/** POST a form-encoded grant to the token endpoint and parse the JSON response. */
export async function requestToken(
  endpoint: string,
  body: URLSearchParams,
): Promise<OAuthTokenResponse> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
  } catch (cause) {
    throw new AuthError("OAuth token request failed (network error)", { cause });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new AuthError(
      `OAuth token request failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return (await response.json()) as OAuthTokenResponse;
}

/**
 * Normalize a token response into a `TokenSet`. Falls back to the current refresh
 * token when the response omits one (many providers only return it on first grant);
 * persists a rotated one when present.
 */
/** Revoke a token at the provider's RFC 7009 revocation endpoint. */
export async function revokeToken(
  endpoint: string,
  token: string,
  tokenTypeHint: "refresh_token" | "access_token",
  client: { clientId: string; clientSecret?: string },
): Promise<void> {
  const body = new URLSearchParams({
    token,
    token_type_hint: tokenTypeHint,
    client_id: client.clientId,
  });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (cause) {
    throw new AuthError("OAuth token revocation failed (network error)", { cause });
  }
  // RFC 7009: the endpoint returns 200 even when the token was already invalid.
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new AuthError(
      `OAuth token revocation failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
}

export function toTokenSet(
  response: OAuthTokenResponse,
  fallbackRefreshToken?: string,
): TokenSet {
  const expiresInSeconds = response.expires_in ?? 3600;
  const tokens: TokenSet = {
    accessToken: response.access_token,
    expiresAt: Date.now() + expiresInSeconds * 1000,
  };
  const refreshToken = response.refresh_token ?? fallbackRefreshToken;
  if (refreshToken !== undefined) tokens.refreshToken = refreshToken;
  if (response.token_type !== undefined) tokens.tokenType = response.token_type;
  if (response.scope !== undefined) tokens.scope = response.scope;
  return tokens;
}
