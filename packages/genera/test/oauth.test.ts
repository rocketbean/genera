import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MemoryTokenStore,
  OAuthCredentialProvider,
  OAuthFlow,
  deriveCodeChallenge,
  generateCodeVerifier,
  generateState,
  type OAuthConfig,
  type TokenSet,
  type TokenStore,
} from "../src/index";

const config: OAuthConfig = {
  clientId: "client-123",
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token",
  redirectUri: "https://app.example.com/callback",
  scopes: ["files.read", "offline_access"],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** The form body of the Nth fetch call, parsed back into URLSearchParams. */
function fetchBody(fetchMock: ReturnType<typeof vi.fn>, call = 0): URLSearchParams {
  const init = fetchMock.mock.calls[call]![1] as RequestInit;
  return init.body as URLSearchParams;
}

/** The URL (first arg) of the Nth fetch call. */
function fetchUrl(fetchMock: ReturnType<typeof vi.fn>, call = 0): string {
  return fetchMock.mock.calls[call]![0] as string;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PKCE", () => {
  it("generates a verifier in the unreserved 43–128 char charset", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("derives the RFC 7636 S256 challenge for the reference vector", async () => {
    const challenge = await deriveCodeChallenge(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    );
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates unique state values", () => {
    expect(generateState()).not.toBe(generateState());
  });
});

describe("OAuthFlow", () => {
  it("builds an authorization URL with PKCE + state", async () => {
    const flow = new OAuthFlow(config);
    const request = await flow.createAuthorizationRequest();
    const url = new URL(request.url);

    expect(url.origin + url.pathname).toBe(config.authorizationEndpoint);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("files.read offline_access");
    expect(url.searchParams.get("state")).toBe(request.state);
    // the challenge in the URL must match the verifier handed back to the caller
    expect(url.searchParams.get("code_challenge")).toBe(
      await deriveCodeChallenge(request.codeVerifier),
    );
  });

  it("exchanges an authorization code for a token set", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const flow = new OAuthFlow(config);
    const tokens = await flow.exchangeCode("auth-code", "verifier-xyz");

    expect(tokens.accessToken).toBe("at-1");
    expect(tokens.refreshToken).toBe("rt-1");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());

    const body = fetchBody(fetchMock);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe("verifier-xyz");
  });
});

describe("OAuthCredentialProvider", () => {
  it("throws AuthError when the store is empty", async () => {
    const provider = new OAuthCredentialProvider(new MemoryTokenStore(), config);
    await expect(provider.getCredential()).rejects.toMatchObject({ code: "AUTH" });
  });

  it("returns the stored token while it is still valid (no network)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = new MemoryTokenStore({
      accessToken: "valid",
      refreshToken: "rt",
      expiresAt: Date.now() + 3_600_000,
    });

    const credential = await new OAuthCredentialProvider(store, config).getCredential();

    expect(credential.accessToken).toBe("valid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and persists the rotated refresh token", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const store = new MemoryTokenStore({
      accessToken: "old",
      refreshToken: "rt-1",
      expiresAt: Date.now() - 1000,
    });
    const provider = new OAuthCredentialProvider(store, config);

    expect((await provider.getCredential()).accessToken).toBe("at-2");

    const body = fetchBody(fetchMock);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
    expect((await store.get())?.refreshToken).toBe("rt-2"); // rotation persisted
  });

  it("refreshes within the expiry-skew window", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: "at-skew", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // Expires in 30s, inside the default 60s skew → must refresh.
    const store = new MemoryTokenStore({
      accessToken: "old",
      refreshToken: "rt-1",
      expiresAt: Date.now() + 30_000,
    });

    const credential = await new OAuthCredentialProvider(store, config).getCredential();

    expect(credential.accessToken).toBe("at-skew");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent refreshes into a single request (single-flight)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = vi.fn(async () => {
      await gate;
      return jsonResponse({ access_token: "at-3", refresh_token: "rt-3", expires_in: 3600 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = new MemoryTokenStore({
      accessToken: "old",
      refreshToken: "rt-1",
      expiresAt: Date.now() - 1000,
    });
    const provider = new OAuthCredentialProvider(store, config);

    const all = Promise.all([
      provider.getCredential(),
      provider.getCredential(),
      provider.getCredential(),
    ]);
    release();
    const credentials = await all;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(credentials.map((c) => c.accessToken)).toEqual(["at-3", "at-3", "at-3"]);
  });

  it("throws AuthError when expired with no refresh token", async () => {
    const store = new MemoryTokenStore({
      accessToken: "old",
      expiresAt: Date.now() - 1000,
    });
    const provider = new OAuthCredentialProvider(store, config);
    await expect(provider.getCredential()).rejects.toMatchObject({ code: "AUTH" });
  });
});

describe("OAuthFlow.handleCallback", () => {
  const saved = { state: "st-123", codeVerifier: "ver-123" };

  function stubExchange(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("verifies state and exchanges the code (accepts a full redirect URL)", async () => {
    const fetchMock = stubExchange();
    const tokens = await new OAuthFlow(config).handleCallback(
      "https://app.example.com/callback?code=the-code&state=st-123",
      saved,
    );
    expect(tokens.accessToken).toBe("at");
    expect(fetchBody(fetchMock).get("code")).toBe("the-code");
    expect(fetchBody(fetchMock).get("code_verifier")).toBe("ver-123");
  });

  it("rejects a state mismatch (CSRF) without calling the token endpoint", async () => {
    const fetchMock = stubExchange();
    await expect(
      new OAuthFlow(config).handleCallback({ code: "x", state: "WRONG" }, saved),
    ).rejects.toMatchObject({ code: "AUTH" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces an error param returned by the provider", async () => {
    await expect(
      new OAuthFlow(config).handleCallback(
        { error: "access_denied", error_description: "user cancelled", state: "st-123" },
        saved,
      ),
    ).rejects.toMatchObject({ code: "AUTH" });
  });

  it("rejects a callback missing the code", async () => {
    await expect(
      new OAuthFlow(config).handleCallback({ state: "st-123" }, saved),
    ).rejects.toMatchObject({ code: "AUTH" });
  });

  it("round-trips with createAuthorizationRequest's state + verifier", async () => {
    const fetchMock = stubExchange();
    const flow = new OAuthFlow(config);
    const request = await flow.createAuthorizationRequest();
    const tokens = await flow.handleCallback({ code: "c", state: request.state }, request);
    expect(tokens.accessToken).toBe("at");
    expect(fetchBody(fetchMock).get("code_verifier")).toBe(request.codeVerifier);
  });
});

describe("OAuthCredentialProvider.revoke", () => {
  const configWithRevoke: OAuthConfig = {
    ...config,
    revocationEndpoint: "https://auth.example.com/revoke",
  };

  it("revokes the refresh token and clears the store", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const store = new MemoryTokenStore({
      accessToken: "at",
      refreshToken: "rt-1",
      expiresAt: Date.now() + 3_600_000,
    });

    await new OAuthCredentialProvider(store, configWithRevoke).revoke();

    expect(fetchUrl(fetchMock)).toBe("https://auth.example.com/revoke");
    const body = fetchBody(fetchMock);
    expect(body.get("token")).toBe("rt-1");
    expect(body.get("token_type_hint")).toBe("refresh_token");
    expect(await store.get()).toBeUndefined();
  });

  it("clears the store locally when no revocation endpoint is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = new MemoryTokenStore({
      accessToken: "at",
      refreshToken: "rt-1",
      expiresAt: Date.now() + 1000,
    });

    await new OAuthCredentialProvider(store, config).revoke();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await store.get()).toBeUndefined();
  });

  it("still clears the store even if the revocation request fails", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const store = new MemoryTokenStore({
      accessToken: "at",
      refreshToken: "rt-1",
      expiresAt: Date.now() + 1000,
    });
    const provider = new OAuthCredentialProvider(store, configWithRevoke);

    await expect(provider.revoke()).rejects.toMatchObject({ code: "AUTH" });
    expect(await store.get()).toBeUndefined();
  });
});

describe("TokenStore swappability", () => {
  it("works with a custom TokenStore implementation", async () => {
    // A minimal store backed by a closure variable — not MemoryTokenStore.
    let saved: TokenSet | undefined = {
      accessToken: "old",
      refreshToken: "rt-1",
      expiresAt: Date.now() - 1000,
    };
    let setCalls = 0;
    const customStore: TokenStore = {
      get: () => Promise.resolve(saved),
      set: (tokens) => {
        saved = tokens;
        setCalls++;
        return Promise.resolve();
      },
      clear: () => {
        saved = undefined;
        return Promise.resolve();
      },
    };
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: "at-new", refresh_token: "rt-2", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const credential = await new OAuthCredentialProvider(customStore, config).getCredential();

    expect(credential.accessToken).toBe("at-new");
    expect(setCalls).toBe(1); // refresh persisted through the custom store
    expect(saved?.refreshToken).toBe("rt-2"); // rotation landed in the custom store
  });
});
