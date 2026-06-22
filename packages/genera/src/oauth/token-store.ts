import type { TokenSet } from "./types";

/**
 * Pluggable persistence for the OAuth token set. The only thing the provider
 * and Tier 2 drivers depend on — keep it tiny. Adapters (file, Redis, DB) can
 * implement it later; a Redis adapter additionally enables cross-instance
 * refresh locking (e.g. `SET NX`).
 */
export interface TokenStore {
  get(): Promise<TokenSet | undefined>;
  set(tokens: TokenSet): Promise<void>;
  clear(): Promise<void>;
}

/** Default in-memory store. Fine for a single process / single user session. */
export class MemoryTokenStore implements TokenStore {
  private tokens: TokenSet | undefined;

  constructor(initial?: TokenSet) {
    this.tokens = initial;
  }

  get(): Promise<TokenSet | undefined> {
    return Promise.resolve(this.tokens);
  }

  set(tokens: TokenSet): Promise<void> {
    this.tokens = tokens;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.tokens = undefined;
    return Promise.resolve();
  }
}
