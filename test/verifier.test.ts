import { describe, expect, it, vi } from "vitest";

import {
  AddonPassConfigurationError,
  AddonPassUnavailableError,
  AddonPassVerifier,
  EntitlementCredentialRejectedError,
  EntitlementScopeMismatchError,
  EntitlementVerificationError,
  hashEntitlementToken,
  InvalidEntitlementTokenError,
  type EntitlementFallback,
  type EntitlementResponse,
} from "../src/index.js";

const TOKEN = Buffer.alloc(32, 7).toString("base64url");
const CREDENTIAL = `ap_v1_abcdefghij.${Buffer.alloc(32, 8).toString("base64url")}`;
const SOURCE_HASH = `0x${"11".repeat(32)}`;
const NOW_MS = Date.parse("2026-09-01T00:00:00.000Z");

function activeResponse(
  overrides: Partial<EntitlementResponse> = {},
): EntitlementResponse {
  return {
    entitled: true,
    finality: "safe",
    graceEnds: "2026-09-04T00:00:10.000Z",
    paidThrough: "2026-09-01T00:00:10.000Z",
    planId: "7",
    sourceBlock: "123",
    sourceBlockHash: SOURCE_HASH,
    status: "active",
    subscriptionId: "42",
    ...overrides,
  };
}

function notFoundResponse(): EntitlementResponse {
  return {
    entitled: false,
    finality: null,
    graceEnds: null,
    paidThrough: null,
    planId: null,
    sourceBlock: null,
    sourceBlockHash: null,
    status: "not_found",
    subscriptionId: null,
  };
}

function apiResponse(
  body: unknown,
  status = 200,
  cacheControl = "private, max-age=5",
): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "cache-control": cacheControl,
      "content-type": "application/json",
    },
    status,
  });
}

function verifier(input: {
  readonly fallback?: EntitlementFallback;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => Date;
}): AddonPassVerifier {
  return new AddonPassVerifier({
    allowedPlanIds: [7n],
    apiBaseUrl: "https://api.addonpass.test",
    fetch: input.fetch,
    integrationCredential: CREDENTIAL,
    now: input.now ?? (() => new Date(NOW_MS)),
    ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
  });
}

describe("AddonPassVerifier", () => {
  it("authenticates a hashed token and serves a bounded cached decision", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(apiResponse(activeResponse())),
    );
    const client = verifier({ fetch });

    await expect(client.verifyToken(TOKEN)).resolves.toMatchObject({
      cached: false,
      entitled: true,
      source: "api",
      status: "active",
    });
    await expect(client.verifyToken(TOKEN)).resolves.toMatchObject({
      cached: true,
      source: "api",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://api.addonpass.test/v1/entitlements/verify"),
      expect.any(Object),
    );
    const request = fetch.mock.calls[0]?.[1];
    expect(request?.headers).toMatchObject({
      authorization: `Bearer ${CREDENTIAL}`,
    });
    expect(request?.body).toBe(
      JSON.stringify({ tokenHash: hashEntitlementToken(TOKEN) }),
    );
    expect(request?.body).not.toContain(TOKEN);
  });

  it("never caches access beyond paid-through", async () => {
    let nowMs = Date.parse("2026-09-01T00:00:08.000Z");
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(apiResponse(activeResponse())),
    );
    const client = verifier({ fetch, now: () => new Date(nowMs) });

    await client.verifyToken(TOKEN);
    nowMs += 1_000;
    await client.verifyToken(TOKEN);
    nowMs += 1_001;
    await client.verifyToken(TOKEN);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("can invalidate a positive cache entry immediately after token rotation", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(apiResponse(activeResponse()))
      .mockResolvedValueOnce(apiResponse(notFoundResponse()));
    const client = verifier({ fetch });

    await expect(client.verifyToken(TOKEN)).resolves.toMatchObject({
      entitled: true,
    });
    client.invalidate(TOKEN);
    await expect(client.verifyToken(TOKEN)).resolves.toMatchObject({
      entitled: false,
      status: "not_found",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed tokens before any network request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = verifier({ fetch });

    await expect(client.verifyToken("not-a-token")).rejects.toBeInstanceOf(
      InvalidEntitlementTokenError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a response outside the configured plan scope", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(apiResponse(activeResponse({ planId: "8" }))),
    );

    await expect(verifier({ fetch }).verifyToken(TOKEN)).rejects.toBeInstanceOf(
      EntitlementScopeMismatchError,
    );
  });

  it("allows a hidden test subscription that reports no plan", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(apiResponse(activeResponse({ planId: null }))),
    );

    await expect(verifier({ fetch }).verifyToken(TOKEN)).resolves.toMatchObject(
      { entitled: true, planId: null },
    );
  });

  it("never bypasses a rejected integration credential", async () => {
    const verifyFallback = vi.fn(() => Promise.resolve(activeResponse()));
    const fallback: EntitlementFallback = {
      verify: verifyFallback,
    };
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(apiResponse({}, 401)),
    );

    await expect(
      verifier({ fallback, fetch }).verifyToken(TOKEN),
    ).rejects.toBeInstanceOf(EntitlementCredentialRejectedError);
    expect(verifyFallback).not.toHaveBeenCalled();
  });

  it("uses an explicitly configured fallback only for API unavailability", async () => {
    const verifyFallback = vi.fn(() => Promise.resolve(activeResponse()));
    const fallback: EntitlementFallback = {
      verify: verifyFallback,
    };
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(apiResponse({}, 503)),
    );

    await expect(
      verifier({ fallback, fetch }).verifyToken(TOKEN),
    ).resolves.toMatchObject({ cached: false, source: "contract" });
    expect(verifyFallback).toHaveBeenCalledWith(hashEntitlementToken(TOKEN));
  });

  it("fails closed when the API is unavailable without an explicit fallback", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.reject(new TypeError("network unavailable")),
    );

    await expect(verifier({ fetch }).verifyToken(TOKEN)).rejects.toBeInstanceOf(
      AddonPassUnavailableError,
    );
  });

  it("fails closed on a malformed successful API response", async () => {
    const verifyFallback = vi.fn(() => Promise.resolve(activeResponse()));
    const fallback: EntitlementFallback = {
      verify: verifyFallback,
    };
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(apiResponse({ entitled: true })),
    );

    await expect(
      verifier({ fallback, fetch }).verifyToken(TOKEN),
    ).rejects.toBeInstanceOf(EntitlementVerificationError);
    expect(verifyFallback).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent verification for one token hash", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const client = verifier({ fetch });
    const first = client.verifyToken(TOKEN);
    const second = client.verifyToken(TOKEN);
    resolveResponse?.(apiResponse(activeResponse()));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized API bodies without a fallback", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(apiResponse({ value: "x".repeat(20_000) })),
    );

    await expect(verifier({ fetch }).verifyToken(TOKEN)).rejects.toBeInstanceOf(
      EntitlementVerificationError,
    );
  });

  it("validates public configuration without echoing credential material", () => {
    expect(
      () =>
        new AddonPassVerifier({
          allowedPlanIds: [],
          apiBaseUrl: "http://api.addonpass.test",
          fetch: vi.fn<typeof globalThis.fetch>(),
          integrationCredential: "invalid",
        }),
    ).toThrow(AddonPassConfigurationError);
  });
});
