import { keccak256, type Hex } from "viem";

import { InvalidEntitlementTokenError } from "./errors.js";

const ENTITLEMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function decodeEntitlementToken(rawToken: string): Uint8Array {
  if (!ENTITLEMENT_TOKEN_PATTERN.test(rawToken)) {
    throw new InvalidEntitlementTokenError();
  }
  const decoded = Buffer.from(rawToken, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== rawToken) {
    decoded.fill(0);
    throw new InvalidEntitlementTokenError();
  }
  return decoded;
}

export function hashEntitlementToken(rawToken: string): Hex {
  const decoded = decodeEntitlementToken(rawToken);
  try {
    return keccak256(decoded);
  } finally {
    decoded.fill(0);
  }
}
