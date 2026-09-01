import {
  getAddress,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";

import {
  AddonPassConfigurationError,
  EntitlementScopeMismatchError,
  EntitlementVerificationError,
} from "./errors.js";
import type { EntitlementFallback, EntitlementResponse } from "./types.js";

const ENTITLEMENT_ABI = parseAbi([
  "function entitlementStatus(bytes32 entitlementHash) view returns (bool entitled, uint64 paidThrough, uint64 graceEnds, uint256 subscriptionId, address developer)",
  "function subscriptions(uint256 subscriptionId) view returns (uint256 planId, address payer, bytes32 entitlementHash, uint64 paidThrough, uint32 remainingCharges, bool cancelled)",
]);

function isoFromSeconds(value: bigint): string {
  const milliseconds = value * 1_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EntitlementVerificationError();
  }
  return new Date(Number(milliseconds)).toISOString();
}

function notFound(): EntitlementResponse {
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

export function createViemEntitlementFallback(input: {
  readonly chainId: number;
  readonly client: Pick<
    PublicClient,
    "getBlock" | "getChainId" | "readContract"
  >;
  readonly contractAddress: Address;
  readonly expectedDeveloperAddress: Address;
}): EntitlementFallback {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new AddonPassConfigurationError();
  }
  let contractAddress: Address;
  let expectedDeveloperAddress: Address;
  try {
    contractAddress = getAddress(input.contractAddress);
    expectedDeveloperAddress = getAddress(input.expectedDeveloperAddress);
  } catch {
    throw new AddonPassConfigurationError();
  }
  if (isAddressEqual(expectedDeveloperAddress, zeroAddress)) {
    throw new AddonPassConfigurationError();
  }

  return {
    async verify(tokenHash): Promise<EntitlementResponse> {
      try {
        const [actualChainId, block] = await Promise.all([
          input.client.getChainId(),
          input.client.getBlock({ blockTag: "safe" }),
        ]);
        if (actualChainId !== input.chainId) {
          throw new EntitlementVerificationError();
        }
        const [entitled, paidThrough, graceEnds, subscriptionId, developer] =
          await input.client.readContract({
            abi: ENTITLEMENT_ABI,
            address: contractAddress,
            args: [tokenHash],
            blockNumber: block.number,
            functionName: "entitlementStatus",
          });
        if (subscriptionId === 0n) return notFound();
        if (!isAddressEqual(developer, expectedDeveloperAddress)) {
          throw new EntitlementScopeMismatchError();
        }
        const [
          planId,
          ,
          storedHash,
          storedPaidThrough,
          remainingCharges,
          cancelled,
        ] = await input.client.readContract({
          abi: ENTITLEMENT_ABI,
          address: contractAddress,
          args: [subscriptionId],
          blockNumber: block.number,
          functionName: "subscriptions",
        });
        if (storedHash !== tokenHash || storedPaidThrough !== paidThrough) {
          throw new EntitlementVerificationError();
        }
        const active = block.timestamp <= paidThrough;
        if (
          active !== entitled &&
          !(entitled && block.timestamp <= graceEnds)
        ) {
          throw new EntitlementVerificationError();
        }
        const status = active
          ? "active"
          : entitled
            ? "grace"
            : cancelled
              ? "cancelled"
              : remainingCharges === 0
                ? "authorization_ended"
                : "expired";
        return {
          entitled,
          finality: "safe",
          graceEnds: isoFromSeconds(graceEnds),
          paidThrough: isoFromSeconds(paidThrough),
          planId: planId.toString(10),
          sourceBlock: block.number.toString(10),
          sourceBlockHash: block.hash,
          status,
          subscriptionId: subscriptionId.toString(10),
        };
      } catch (error: unknown) {
        if (
          error instanceof EntitlementScopeMismatchError ||
          error instanceof EntitlementVerificationError
        ) {
          throw error;
        }
        throw new EntitlementVerificationError();
      }
    },
  };
}
