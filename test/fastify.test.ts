import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { createFastifyStremioProtection } from "../src/fastify.js";
import type { EntitlementDecision } from "../src/index.js";

const TOKEN = Buffer.alloc(32, 7).toString("base64url");

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

describe("Fastify Stremio adapter", () => {
  it("authorizes and scrubs a protected route before its handler", async () => {
    const app = Fastify();
    const protection = createFastifyStremioProtection({
      access: {
        addonId: "com.example.fastify",
        addonName: "Fastify Add-on",
        managementUrl: "https://addonpass.test/subscriptions/42",
      },
      verifier: { verifyToken: () => Promise.resolve(decision()) },
    });
    app.get(
      "/addonpass/:token/manifest.json",
      { preHandler: protection.preHandler },
      (request) => {
        const authorization = protection.authorization(request);
        return {
          path: request.raw.url,
          resource: authorization.route.resource,
          status: authorization.decision.status,
        };
      },
    );

    const response = await app.inject({
      method: "GET",
      url: `/addonpass/${TOKEN}/manifest.json`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.json()).toEqual({
      path: "/manifest.json",
      resource: "manifest",
      status: "active",
    });
    await app.close();
  });

  it("returns renewal JSON without invoking a protected handler", async () => {
    const app = Fastify();
    const handler = vi.fn(() => ({ streams: [] }));
    const protection = createFastifyStremioProtection({
      access: {
        addonId: "com.example.fastify",
        addonName: "Fastify Add-on",
        managementUrl: "https://addonpass.test/subscriptions/42",
      },
      verifier: {
        verifyToken: () =>
          Promise.resolve(decision({ entitled: false, status: "expired" })),
      },
    });
    app.get(
      "/addonpass/:token/stream/:type/:id",
      { preHandler: protection.preHandler },
      handler,
    );

    const response = await app.inject({
      method: "GET",
      url: `/addonpass/${TOKEN}/stream/movie/tt1254207.json`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      streams: [
        {
          externalUrl: "https://addonpass.test/subscriptions/42",
        },
      ],
    });
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });
});
