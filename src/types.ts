import { z } from "zod";

const decimalSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const positiveDecimalSchema = z.string().regex(/^[1-9][0-9]*$/);
const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const entitlementResponseSchema = z
  .object({
    entitled: z.boolean(),
    finality: z.enum(["provisional", "safe", "finalized"]).nullable(),
    graceEnds: z.iso.datetime().nullable(),
    paidThrough: z.iso.datetime().nullable(),
    planId: positiveDecimalSchema.nullable(),
    sourceBlock: decimalSchema.nullable(),
    sourceBlockHash: bytes32Schema.nullable(),
    status: z.enum([
      "active",
      "authorization_ended",
      "cancelled",
      "expired",
      "grace",
      "not_found",
    ]),
    subscriptionId: positiveDecimalSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const entitledStatus =
      value.status === "active" || value.status === "grace";
    if (value.entitled !== entitledStatus) {
      context.addIssue({
        code: "custom",
        message: "inconsistent entitlement state",
      });
    }
    const sourceValues = [
      value.finality,
      value.graceEnds,
      value.paidThrough,
      value.planId,
      value.sourceBlock,
      value.sourceBlockHash,
      value.subscriptionId,
    ];
    const complete = sourceValues.every((item) => item !== null);
    const empty = sourceValues.every((item) => item === null);
    if (
      (value.status === "not_found" && !empty) ||
      (value.status !== "not_found" && !complete)
    ) {
      context.addIssue({
        code: "custom",
        message: "incomplete entitlement source",
      });
    }
  });

export type EntitlementResponse = z.infer<typeof entitlementResponseSchema>;

export interface EntitlementDecision extends EntitlementResponse {
  readonly cached: boolean;
  readonly source: "api" | "contract";
}

export interface EntitlementFallback {
  verify(tokenHash: `0x${string}`): Promise<EntitlementResponse>;
}
