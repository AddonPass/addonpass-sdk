import { describe, expect, it, vi } from "vitest";

import {
  authorizeStremioRequest,
  UnsupportedStremioRouteError,
  type EntitlementDecision,
} from "../src/index.js";

const TOKEN = Buffer.alloc(32, 7).toString("base64url");

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

describe("Stremio route authorization", () => {
  it("resolves a tokenized manifest without retaining the bearer token", async () => {
    const verifyToken = vi.fn(() => Promise.resolve(activeDecision()));

    const result = await authorizeStremioRequest(
      { verifyToken },
      new URL(`https://addon.test/addonpass/${TOKEN}/manifest.json`),
    );

    expect(verifyToken).toHaveBeenCalledWith(TOKEN);
    expect(result.route).toEqual({
      id: null,
      resource: "manifest",
      type: null,
      upstreamPath: "/manifest.json",
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("preserves official resource and extra-argument paths", async () => {
    const result = await authorizeStremioRequest(
      { verifyToken: () => Promise.resolve(activeDecision()) },
      new URL(
        `https://addon.test/addonpass/${TOKEN}/catalog/movie/reference/search=big%20buck.json?skip=0`,
      ),
    );

    expect(result.route).toEqual({
      id: "reference",
      resource: "catalog",
      type: "movie",
      upstreamPath: "/catalog/movie/reference/search=big%20buck.json",
    });
  });

  it.each([
    "/manifest.json",
    `/other/${TOKEN}/manifest.json`,
    `/addonpass/${TOKEN}/subtitles/movie/example.json`,
    `/addonpass/${TOKEN}/stream/movie/%2Fetc.json`,
    `/addonpass/${TOKEN}/stream/../example.json`,
  ])("rejects an unprotected or ambiguous route", async (pathname) => {
    await expect(
      authorizeStremioRequest(
        { verifyToken: () => Promise.resolve(activeDecision()) },
        new URL(pathname, "https://addon.test"),
      ),
    ).rejects.toBeInstanceOf(UnsupportedStremioRouteError);
  });
});
