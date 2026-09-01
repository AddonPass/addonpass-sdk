import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";

import {
  hashEntitlementToken,
  InvalidEntitlementTokenError,
} from "../src/index.js";

describe("entitlement tokens", () => {
  it("hashes exactly 256 decoded bits with Ethereum keccak256", () => {
    const bytes = Buffer.alloc(32, 7);
    const token = bytes.toString("base64url");

    expect(token).toHaveLength(43);
    expect(hashEntitlementToken(token)).toBe(keccak256(bytes));
  });

  it.each([
    "",
    "a".repeat(42),
    `${"a".repeat(43)}=`,
    "!".repeat(43),
    `${Buffer.alloc(32).toString("base64url").slice(0, -1)}B`,
  ])("rejects malformed or non-canonical bearer material", (token) => {
    expect(() => hashEntitlementToken(token)).toThrow(
      InvalidEntitlementTokenError,
    );
  });
});
