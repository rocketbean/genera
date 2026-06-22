import { AuthError } from "../errors";
import type { CredentialProvider } from "../credentials";
import { requestToken, revokeToken, toTokenSet } from "./token-endpoint";
import type { TokenStore } from "./token-store";
import type { OAuthConfig, OAuthCredential, TokenSet } from "./types";

export interface OAuthCredentialProviderOptions {
  /** Refresh this many ms before the access token actually expires. Default 60_000. */
  skewMs?: number;
}

/**
 * The `CredentialProvider` behind every Tier 2 driver. Operations only ever ask
 * for a *fresh* credential; this class hides refresh entirely. It handles the
 * three correctness traps:
 *   - expiry skew      — refresh before the boundary, never racing it,
 *   - rotation         — persist a new refresh token when the provider issues one,
 *   - the refresh race — concurrent callers share ONE in-flight refresh.
 *
 * Drivers never implement refresh themselves; the logic lives once, here.
 */
export class OAuthCredentialProvider implements CredentialProvider<OAuthCredential> {
  private readonly skewMs: number;
  private inflightRefresh: Promise<TokenSet> | undefined;

  constructor(
    private readonly store: TokenStore,
    private readonly config: OAuthConfig,
    options: OAuthCredentialProviderOptions = {},
  ) {
    this.skewMs = options.skewMs ?? 60_000;
  }

  async getCredential(): Promise<OAuthCredential> {
    const tokens = await this.store.get();
    if (!tokens) {
      throw new AuthError("Not authenticated: no token in the store. Run the OAuthFlow first.");
    }
    if (Date.now() < tokens.expiresAt - this.skewMs) {
      return toCredential(tokens);
    }
    return toCredential(await this.refresh(tokens));
  }

  /**
   * Sign out: revoke the tokens at the provider (RFC 7009, if a revocation
   * endpoint is configured) and clear the local store. The store is always
   * cleared — even if the network revocation fails — so local sign-out is
   * reliable; a revocation failure still propagates to the caller.
   */
  async revoke(): Promise<void> {
    const tokens = await this.store.get();
    try {
      if (tokens && this.config.revocationEndpoint) {
        // Revoking the refresh token cascades to its access tokens at most providers.
        const token = tokens.refreshToken ?? tokens.accessToken;
        const hint = tokens.refreshToken ? "refresh_token" : "access_token";
        await revokeToken(this.config.revocationEndpoint, token, hint, this.config);
      }
    } finally {
      await this.store.clear();
    }
  }

  /** Single-flight: concurrent callers share one in-flight refresh, not N. */
  private refresh(current: TokenSet): Promise<TokenSet> {
    if (this.inflightRefresh) return this.inflightRefresh;
    this.inflightRefresh = this.doRefresh(current).finally(() => {
      this.inflightRefresh = undefined;
    });
    return this.inflightRefresh;
  }

  private async doRefresh(current: TokenSet): Promise<TokenSet> {
    if (!current.refreshToken) {
      throw new AuthError("Access token expired and no refresh token is available");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: this.config.clientId,
    });
    if (this.config.clientSecret) body.set("client_secret", this.config.clientSecret);

    // Keep the old refresh token if the provider didn't rotate it.
    const next = toTokenSet(
      await requestToken(this.config.tokenEndpoint, body),
      current.refreshToken,
    );
    await this.store.set(next);
    return next;
  }
}

function toCredential(tokens: TokenSet): OAuthCredential {
  return { accessToken: tokens.accessToken, tokenType: tokens.tokenType ?? "Bearer" };
}
