import type { PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  createViemEntitlementFallback,
  EntitlementScopeMismatchError,
  EntitlementVerificationError,
} from "../src/index.js";

const CONTRACT = "0x1111111111111111111111111111111111111111";
const DEVELOPER = "0x2222222222222222222222222222222222222222";
const OTHER_DEVELOPER = "0x3333333333333333333333333333333333333333";
const TOKEN_HASH = `0x${"44".repeat(32)}` as const;
const BLOCK_HASH = `0x${"55".repeat(32)}` as const;

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

function fallback(value: ReturnType<typeof client>["client"]) {
  return createViemEntitlementFallback({
    chainId: 84_532,
    client: value,
    contractAddress: CONTRACT,
    expectedDeveloperAddress: DEVELOPER,
  });
}

describe("safe-block contract fallback", () => {
  it("reads and cross-checks the entitlement at one safe block", async () => {
    const fake = client({});

    await expect(
      fallback(fake.client).verify(TOKEN_HASH),
    ).resolves.toMatchObject({
      entitled: true,
      finality: "safe",
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
