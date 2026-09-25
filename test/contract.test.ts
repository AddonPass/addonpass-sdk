import type { PublicClient } from "viem";
import { assert, describe, expect, it, vi } from "vitest";

import {
  AddonPassVerifier,
  createFetchStremioHandler,
  createViemEntitlementFallback,
  EntitlementScopeMismatchError,
  EntitlementVerificationError,
  hashEntitlementToken,
} from "../src/index.js";

const CONTRACT = "0x1111111111111111111111111111111111111111";
const DEVELOPER = "0x2222222222222222222222222222222222222222";
const OTHER_DEVELOPER = "0x3333333333333333333333333333333333333333";
const TOKEN = Buffer.alloc(32, 7).toString("base64url");
const TOKEN_HASH = hashEntitlementToken(TOKEN);
const BLOCK_HASH = `0x${"55".repeat(32)}` as const;
const PAID_THROUGH_MS = 1_788_220_810_000;
const GRACE_ENDS_MS = 1_788_480_010_000;

function client(input: {
  readonly blockTimestamp?: bigint;
  readonly cancelled?: boolean;
  readonly chainId?: number;
  readonly developer?: `0x${string}`;
  readonly entitled?: boolean;
  readonly remainingCharges?: number;
  readonly subscriptionId?: bigint;
}) {
  const readContract = vi.fn((request: { readonly functionName: string }) => {
    if (request.functionName === "entitlementStatus") {
      return Promise.resolve([
        input.entitled ?? true,
        1_788_220_810n,
        1_788_480_010n,
        input.subscriptionId ?? 42n,
        input.developer ?? DEVELOPER,
      ] as const);
    }
    return Promise.resolve([
      7n,
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      TOKEN_HASH,
      1_788_220_810n,
      input.remainingCharges ?? 3,
      input.cancelled ?? false,
    ] as const);
  });
  const value = {
    getBlock: vi.fn(() =>
      Promise.resolve({
        hash: BLOCK_HASH,
        number: 123n,
        timestamp: input.blockTimestamp ?? 1_788_220_800n,
      }),
    ),
    getChainId: vi.fn(() => Promise.resolve(input.chainId ?? 84_532)),
    readContract,
  };
  return {
    client: value as unknown as Pick<
      PublicClient,
      "getBlock" | "getChainId" | "readContract"
    >,
    readContract,
  };
}

function fallback(
  value: ReturnType<typeof client>["client"],
  now: () => Date = () => new Date(1_788_220_800_000),
) {
  return createViemEntitlementFallback({
    chainId: 84_532,
    client: value,
    contractAddress: CONTRACT,
    expectedDeveloperAddress: DEVELOPER,
    now,
  });
}

describe("safe-block contract fallback", () => {
  it.each([
    { cancelled: true, remainingCharges: 3 },
    { cancelled: false, remainingCharges: 0 },
  ])(
    "rejects stale paid access and keeps the add-on closed: %j",
    async (state) => {
      let nowMs = PAID_THROUGH_MS;
      const safeFallback = fallback(
        client({ ...state, blockTimestamp: 1_788_220_809n }).client,
        () => new Date(nowMs),
      );
      await expect(safeFallback.verify(TOKEN_HASH)).resolves.toMatchObject({
        entitled: true,
        status: "active",
      });

      nowMs += 1;
      await expect(safeFallback.verify(TOKEN_HASH)).rejects.toBeInstanceOf(
        EntitlementVerificationError,
      );

      const upstream = vi.fn(() => Response.json({ streams: [] }));
      const handler = createFetchStremioHandler({
        access: {
          addonId: "com.example.private-addon",
          addonName: "Private Add-on",
          managementUrl: "https://addonpass.test/subscriptions",
        },
        upstream,
        verifier: new AddonPassVerifier({
          allowedPlanIds: [7n],
          apiBaseUrl: "https://api.addonpass.test",
          fallback: safeFallback,
          fetch: vi.fn<typeof globalThis.fetch>(() =>
            Promise.resolve(new Response(null, { status: 503 })),
          ),
          integrationCredential: `ap_v1_abcdefghij.${Buffer.alloc(32, 8).toString("base64url")}`,
          now: () => new Date(nowMs),
        }),
      });
      const response = await handler(
        new Request(
          `https://addon.test/addonpass/${TOKEN}/stream/movie/tt1254207.json`,
        ),
      );

      expect(response.status).toBe(503);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("allows reported grace through its exact deadline and rejects an older positive snapshot afterward", async () => {
    let nowMs = GRACE_ENDS_MS;
    const safeFallback = fallback(
      client({ blockTimestamp: 1_788_480_009n }).client,
      () => new Date(nowMs),
    );
    await expect(safeFallback.verify(TOKEN_HASH)).resolves.toMatchObject({
      entitled: true,
      status: "grace",
    });

    nowMs += 1;
    await expect(safeFallback.verify(TOKEN_HASH)).rejects.toBeInstanceOf(
      EntitlementVerificationError,
    );
  });

  it("checks the application clock after a delayed contract read", async () => {
    let nowMs = PAID_THROUGH_MS - 1;
    const fake = client({});
    const originalRead = fake.readContract.getMockImplementation();
    assert(originalRead !== undefined);
    fake.readContract.mockImplementation((request) => {
      if (request.functionName === "subscriptions") nowMs += 2;
      return originalRead(request);
    });

    await expect(
      fallback(fake.client, () => new Date(nowMs)).verify(TOKEN_HASH),
    ).rejects.toBeInstanceOf(EntitlementVerificationError);
  });

  it("reads and cross-checks the entitlement at the latest block", async () => {
    const fake = client({});

    await expect(
      fallback(fake.client).verify(TOKEN_HASH),
    ).resolves.toMatchObject({
      entitled: true,
      finality: "provisional",
      planId: "7",
      sourceBlock: "123",
      sourceBlockHash: BLOCK_HASH,
      status: "active",
      subscriptionId: "42",
    });
    expect(fake.readContract).toHaveBeenCalledTimes(2);
    expect(
      fake.readContract.mock.calls.map(([request]) => request.functionName),
    ).toEqual(["entitlementStatus", "subscriptions"]);
  });

  it("distinguishes grace and terminal authorization states", async () => {
    await expect(
      fallback(
        client({ blockTimestamp: 1_788_220_811n, entitled: true }).client,
      ).verify(TOKEN_HASH),
    ).resolves.toMatchObject({ entitled: true, status: "grace" });

    await expect(
      fallback(
        client({
          blockTimestamp: 1_788_480_011n,
          entitled: false,
          remainingCharges: 0,
        }).client,
      ).verify(TOKEN_HASH),
    ).resolves.toMatchObject({
      entitled: false,
      status: "authorization_ended",
    });

    await expect(
      fallback(
        client({
          blockTimestamp: 1_788_480_011n,
          cancelled: true,
          entitled: false,
        }).client,
      ).verify(TOKEN_HASH),
    ).resolves.toMatchObject({ entitled: false, status: "cancelled" });

    await expect(
      fallback(
        client({
          blockTimestamp: 1_788_480_011n,
          entitled: false,
        }).client,
      ).verify(TOKEN_HASH),
    ).resolves.toMatchObject({ entitled: false, status: "expired" });
  });

  it("returns a generic miss without reading a nonexistent subscription", async () => {
    const fake = client({ entitled: false, subscriptionId: 0n });

    await expect(
      fallback(fake.client).verify(TOKEN_HASH),
    ).resolves.toMatchObject({
      entitled: false,
      finality: null,
      status: "not_found",
    });
    expect(fake.readContract).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the contract developer is outside the configured scope", async () => {
    await expect(
      fallback(client({ developer: OTHER_DEVELOPER }).client).verify(
        TOKEN_HASH,
      ),
    ).rejects.toBeInstanceOf(EntitlementScopeMismatchError);
  });

  it("fails closed on a provider connected to another chain", async () => {
    await expect(
      fallback(client({ chainId: 1 }).client).verify(TOKEN_HASH),
    ).rejects.toBeInstanceOf(EntitlementVerificationError);
  });
});
