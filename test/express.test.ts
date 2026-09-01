import { createServer } from "node:http";

import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import {
  createExpressStremioMiddleware,
  expressAddonPassAuthorization,
} from "../src/express.js";
import type { EntitlementDecision } from "../src/index.js";

const TOKEN = Buffer.alloc(32, 7).toString("base64url");
const servers: ReturnType<typeof createServer>[] = [];

function activeDecision(): EntitlementDecision {
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
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        }),
    ),
  );
});

async function listen(): Promise<string> {
  const app = express();
  app.use(
    createExpressStremioMiddleware({
      access: {
        addonId: "com.example.express",
        addonName: "Express Add-on",
        managementUrl: "https://addonpass.test/subscriptions/42",
      },
      verifier: { verifyToken: () => Promise.resolve(activeDecision()) },
    }),
  );
  app.get("/manifest.json", (request, response) => {
    const authorization = expressAddonPassAuthorization(response);
    response.json({
      path: request.originalUrl,
      resource: authorization.route.resource,
      status: authorization.decision.status,
    });
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

describe("Express Stremio adapter", () => {
  it("scrubs the bearer URL before downstream routing", async () => {
    const origin = await listen();

    const response = await fetch(`${origin}/addonpass/${TOKEN}/manifest.json`);

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({
      path: "/manifest.json",
      resource: "manifest",
      status: "active",
    });
  });

  it("does not expose the downstream route without a token", async () => {
    const origin = await listen();

    const response = await fetch(`${origin}/manifest.json`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "access_denied" });
  });
});
