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
}
