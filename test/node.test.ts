import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  createNodeStremioHandler,
  type EntitlementDecision,
} from "../src/index.js";

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

async function listen(
  handler: ReturnType<typeof createNodeStremioHandler>,
): Promise<string> {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
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

describe("Node HTTP Stremio adapter", () => {
  it("serves only the tokenized route through the protected handler", async () => {
    const origin = await listen(
      createNodeStremioHandler({
        access: {
          addonId: "com.example.reference",
          addonName: "Reference",
          managementUrl: "https://addonpass.test/subscriptions/42",
        },
        upstream: (request) =>
          Response.json({
            id: "com.example.reference",
            protectedPath: new URL(request.url).pathname,
          }),
        verifier: { verifyToken: () => Promise.resolve(activeDecision()) },
      }),
    );

    const protectedResponse = await fetch(
      `${origin}/addonpass/${TOKEN}/manifest.json`,
    );
    expect(protectedResponse.status).toBe(200);
    expect(protectedResponse.headers.get("access-control-allow-origin")).toBe(
      "*",
    );
    await expect(protectedResponse.json()).resolves.toMatchObject({
      protectedPath: "/manifest.json",
    });

    const unprotectedResponse = await fetch(`${origin}/manifest.json`);
    expect(unprotectedResponse.status).toBe(404);
  });
});
