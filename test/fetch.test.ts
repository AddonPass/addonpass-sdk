import { describe, expect, it, vi } from "vitest";

import {
  AddonPassUnavailableError,
  createFetchStremioHandler,
  InvalidEntitlementTokenError,
  type EntitlementDecision,
  type FetchStremioUpstream,
} from "../src/index.js";

const TOKEN = Buffer.alloc(32, 7).toString("base64url");
const ACCESS = {
  addonId: "com.example.private-addon",
  addonName: "Private Add-on",
  managementUrl: "https://addonpass.test/subscriptions/42",
} as const;

function decision(
  overrides: Partial<EntitlementDecision> = {},
): EntitlementDecision {
  return {
    cached: false,
    entitled: true,
    finality: "safe",
    graceEnds: "2026-09-04T00:00:00.000Z",
    paidThrough: "2026-09-01T00:00:00.000Z",
    planId: "7",
    source: "api",
    sourceBlock: "123",
    sourceBlockHash: `0x${"11".repeat(32)}`,
    status: "active",
    subscriptionId: "42",
    ...overrides,
  };
}

describe("Fetch Stremio adapter", () => {
  it("rewrites an entitled request before invoking the add-on", async () => {
    const upstream = vi.fn<FetchStremioUpstream>((request, authorization) =>
      Promise.resolve(
        Response.json({
          resource: authorization.route.resource,
          upstreamUrl: request.url,
        }),
      ),
    );
    const handler = createFetchStremioHandler({
      access: ACCESS,
      upstream,
      verifier: { verifyToken: () => Promise.resolve(decision()) },
    });

    const response = await handler(
      new Request(
        `https://addon.test/addonpass/${TOKEN}/stream/movie/tt1254207.json?videoHash=abc`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(upstream).toHaveBeenCalledTimes(1);
    const [request, authorization] = upstream.mock.calls[0] ?? [];
    expect(request?.url).toBe(
      "https://addon.test/stream/movie/tt1254207.json?videoHash=abc",
    );
    expect(authorization?.route.resource).toBe("stream");
    expect(JSON.stringify(authorization)).not.toContain(TOKEN);
  });

  it("returns valid renewal JSON without invoking the add-on after expiry", async () => {
    const upstream = vi.fn(() => Response.json({ streams: [] }));
    const handler = createFetchStremioHandler({
      access: ACCESS,
      upstream,
      verifier: {
        verifyToken: () =>
          Promise.resolve(decision({ entitled: false, status: "expired" })),
      },
    });

    const response = await handler(
      new Request(
        `https://addon.test/addonpass/${TOKEN}/stream/movie/tt1254207.json`,
      ),
    );
    const body = (await response.json()) as {
      readonly streams: readonly { readonly externalUrl: string }[];
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.streams[0]?.externalUrl).toBe(ACCESS.managementUrl);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps invalid bearer material generic", async () => {
    const handler = createFetchStremioHandler({
      access: ACCESS,
      upstream: vi.fn(() => Response.json({})),
      verifier: {
        verifyToken: () => Promise.reject(new InvalidEntitlementTokenError()),
      },
    });

    const response = await handler(
      new Request(`https://addon.test/addonpass/${TOKEN}/manifest.json`),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "access_denied" });
  });

  it("distinguishes provider unavailability without opening access", async () => {
    const upstream = vi.fn(() => Response.json({}));
    const handler = createFetchStremioHandler({
      access: ACCESS,
      upstream,
      verifier: {
        verifyToken: () => Promise.reject(new AddonPassUnavailableError()),
      },
    });

    const response = await handler(
      new Request(`https://addon.test/addonpass/${TOKEN}/manifest.json`),
    );

    expect(response.status).toBe(503);
    expect((await response.json()) as object).toEqual({
      error: "verification_unavailable",
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("never exposes an unprotected add-on path", async () => {
    const upstream = vi.fn(() => Response.json({}));
    const handler = createFetchStremioHandler({
      access: ACCESS,
      upstream,
      verifier: { verifyToken: () => Promise.resolve(decision()) },
    });

    const response = await handler(
      new Request("https://addon.test/manifest.json"),
    );

    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("handles CORS preflight without disclosing authorization state", async () => {
    const verifyToken = vi.fn(() => Promise.resolve(decision()));
    const handler = createFetchStremioHandler({
      access: ACCESS,
      upstream: vi.fn(() => Response.json({})),
      verifier: { verifyToken },
    });

    const response = await handler(
      new Request(`https://addon.test/addonpass/${TOKEN}/manifest.json`, {
        method: "OPTIONS",
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(verifyToken).not.toHaveBeenCalled();
  });
});
