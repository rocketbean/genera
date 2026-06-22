import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MemoryTokenStore,
  OAuthCredentialProvider,
  OAuthFlow,
  deriveCodeChallenge,
  generateCodeVerifier,
  generateState,
  type OAuthConfig,
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
