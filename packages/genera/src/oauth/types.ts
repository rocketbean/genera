/**
 * Shared OAuth2 types (plan Phase 3). All web-standard so the auth layer stays
 * isomorphic — no provider SDKs, no Node built-ins.
 */

/** A persisted token set. `expiresAt` is epoch milliseconds. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType?: string;
  scope?: string;
}

/** The credential payload the provider yields (the `CredentialProvider<T>` `T`). */
export interface OAuthCredential {
  accessToken: string;
  tokenType: string;
}

/** Static configuration for an OAuth2 + PKCE client. */
export interface OAuthConfig {
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** RFC 7009 revocation endpoint. Optional — `revoke()` clears locally without it. */
  revocationEndpoint?: string;
  redirectUri: string;
  /** Default scopes for the authorization request. */
  scopes?: string[];
  /** Confidential (server) clients only; public clients omit it (PKCE handles them). */
  clientSecret?: string;
  /** Extra params appended to the authorization URL (e.g. `access_type`, `prompt`). */
  extraAuthParams?: Record<string, string>;
}

/** The raw shape returned by an OAuth2 token endpoint. */
export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}
