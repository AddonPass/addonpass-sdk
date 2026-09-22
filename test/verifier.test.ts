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
  readonly cacheTtlMs?: number;
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
    ...(input.cacheTtlMs === undefined ? {} : { cacheTtlMs: input.cacheTtlMs }),
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
    await expect(client.verifyToken(TOKEN)).rejects.toBeInstanceOf(
      EntitlementVerificationError,
    );

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["active", "grace"] as const)(
    "rejects expired %s responses from the API and a custom fallback even without caching",
    async (status) => {
      const response = activeResponse({ status });
      const deadline = Date.parse(
        (status === "grace" ? response.graceEnds : response.paidThrough) ?? "",
      );
      for (const source of ["api", "contract"] as const) {
        const client = verifier({
          cacheTtlMs: 0,
          fallback: { verify: () => Promise.resolve(response) },
          fetch: vi.fn<typeof globalThis.fetch>(() =>
            Promise.resolve(
              apiResponse(response, source === "api" ? 200 : 503, "no-store"),
            ),
          ),
          now: () => new Date(deadline + 1),
        });

        await expect(client.verifyToken(TOKEN)).rejects.toBeInstanceOf(
          EntitlementVerificationError,
        );
      }
    },
  );

  it.each(["active", "grace"] as const)(
    "allows reported %s access through its exact deadline",
    async (status) => {
      const response = activeResponse({ status });
      let nowMs =
        Date.parse(
          (status === "grace" ? response.graceEnds : response.paidThrough) ??
            "",
        ) - 1;
      const client = verifier({
        fetch: vi.fn<typeof globalThis.fetch>(() =>
          Promise.resolve(apiResponse(response)),
        ),
        now: () => new Date(nowMs),
      });

      await expect(client.verifyToken(TOKEN)).resolves.toMatchObject({
        entitled: true,
        status,
      });
      nowMs += 1;
      await expect(client.verifyToken(TOKEN)).resolves.toMatchObject({
        entitled: true,
        status,
      });
    },
  );

  it.each(["active", "grace"] as const)(
    "checks %s expiry when a delayed response reaches concurrent callers",
    async (status) => {
      const response = activeResponse({ status });
      let nowMs =
        Date.parse(
          (status === "grace" ? response.graceEnds : response.paidThrough) ??
            "",
        ) - 1;
      let resolveResponse: ((response: Response) => void) | undefined;
      const fetch = vi.fn<typeof globalThis.fetch>(
        () =>
          new Promise<Response>((resolve) => {
            resolveResponse = resolve;
          }),
      );
      const client = verifier({ fetch, now: () => new Date(nowMs) });
      const first = client.verifyToken(TOKEN);
      const second = client.verifyToken(TOKEN);

      nowMs += 2;
      resolveResponse?.(apiResponse(response));

      await expect(first).rejects.toBeInstanceOf(EntitlementVerificationError);
      await expect(second).rejects.toBeInstanceOf(EntitlementVerificationError);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("does not allow an invalid application clock to bypass expiry", async () => {
    const client = verifier({
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(apiResponse(activeResponse())),
      ),
      now: () => new Date(Number.NaN),
    });

    await expect(client.verifyToken(TOKEN)).rejects.toBeInstanceOf(
      EntitlementVerificationError,
    );
  });

  it("accepts a fresh renewal after refusing a stale positive response", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(apiResponse(activeResponse()))
      .mockResolvedValueOnce(
        apiResponse(
          activeResponse({
            paidThrough: "2026-10-01T00:00:10.000Z",
            graceEnds: "2026-10-04T00:00:10.000Z",
          }),
        ),
      );
    const client = verifier({
      fetch,
      now: () => new Date("2026-09-01T00:00:10.001Z"),
    });

    await expect(client.verifyToken(TOKEN)).rejects.toBeInstanceOf(
      EntitlementVerificationError,
    );
    await expect(client.verifyToken(TOKEN)).resolves.toMatchObject({
      entitled: true,
      paidThrough: "2026-10-01T00:00:10.000Z",
      cached: false,
    });
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
