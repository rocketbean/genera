import { AuthError } from "../errors";
import { deriveCodeChallenge, generateCodeVerifier, generateState } from "./pkce";
import { requestToken, toTokenSet } from "./token-endpoint";
import type { OAuthConfig, TokenSet } from "./types";

/** Everything the app must keep between the redirect out and the redirect back. */
export interface AuthorizationRequest {
  /** Send the user here. */
  url: string;
  /** CSRF token — verify it matches when the redirect returns. */
  state: string;
  /** PKCE verifier — pass it to `exchangeCode` after the redirect. */
  codeVerifier: string;
}

export interface CreateAuthorizationRequestOptions {
  /** Override the generated CSRF state. */
  state?: string;
  /** Override the config's default scopes for this request. */
  scopes?: string[];
}

/** The parameters an OAuth2 redirect callback carries. */
export interface OAuthCallbackParams {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

/** Accept a redirect URL, a query string, `URLSearchParams`, or a plain object. */
function parseCallbackParams(
  callback: string | URLSearchParams | OAuthCallbackParams,
): URLSearchParams {
  if (callback instanceof URLSearchParams) return callback;
  if (typeof callback === "string") {
    try {
      return new URL(callback).searchParams;
    } catch {
      return new URLSearchParams(callback.startsWith("?") ? callback.slice(1) : callback);
    }
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(callback)) {
    if (value !== undefined) params.set(key, value);
  }
  return params;
}

/**
 * The interactive authorization-code↔token exchange — a standalone helper, NOT
 * coupled to any storage operation (plan Phase 3). Acquisition is the app's
 * concern; once it has a `TokenSet`, it seeds a `TokenStore` and lets
 * `OAuthCredentialProvider` keep it fresh.
 */
export class OAuthFlow {
  constructor(private readonly config: OAuthConfig) {}

  /**
   * Build the authorization URL plus the PKCE verifier and CSRF state. The app
   * persists `state` + `codeVerifier`, redirects the user to `url`, and on return
   * verifies `state` before calling `exchangeCode`.
   */
  async createAuthorizationRequest(
    options: CreateAuthorizationRequestOptions = {},
  ): Promise<AuthorizationRequest> {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await deriveCodeChallenge(codeVerifier);
    const state = options.state ?? generateState();

    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });
    const scopes = options.scopes ?? this.config.scopes;
    if (scopes && scopes.length > 0) params.set("scope", scopes.join(" "));
    for (const [key, value] of Object.entries(this.config.extraAuthParams ?? {})) {
      params.set(key, value);
    }

    return {
      url: `${this.config.authorizationEndpoint}?${params.toString()}`,
      state,
      codeVerifier,
    };
  }

  /** Exchange the authorization code (+ the saved PKCE verifier) for a token set. */
  async exchangeCode(code: string, codeVerifier: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: codeVerifier,
    });
    if (this.config.clientSecret) body.set("client_secret", this.config.clientSecret);
    return toTokenSet(await requestToken(this.config.tokenEndpoint, body));
  }

  /**
   * Handle the redirect back from the provider: surface any `error`, verify the
   * CSRF `state` matches what `createAuthorizationRequest` returned, then exchange
   * the code. Pass the saved `{ state, codeVerifier }` plus the callback — a full
   * redirect URL, a query string, `URLSearchParams`, or a parsed object.
   */
  async handleCallback(
    callback: string | URLSearchParams | OAuthCallbackParams,
    saved: Pick<AuthorizationRequest, "state" | "codeVerifier">,
  ): Promise<TokenSet> {
    const params = parseCallbackParams(callback);

    const error = params.get("error");
    if (error) {
      const description = params.get("error_description");
      throw new AuthError(
        `Authorization failed: ${error}${description ? ` — ${description}` : ""}`,
      );
    }
    if (params.get("state") !== saved.state) {
      throw new AuthError("OAuth state mismatch (possible CSRF) — aborting code exchange");
    }
    const code = params.get("code");
    if (!code) {
      throw new AuthError("Authorization response is missing the code parameter");
    }
    return this.exchangeCode(code, saved.codeVerifier);
  }
}
