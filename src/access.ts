import { EntitlementVerificationError } from "./errors.js";
import type { EntitlementResponse } from "./types.js";

export function accessDeadlineMs(response: EntitlementResponse): number | null {
  const deadline =
    response.status === "grace" ? response.graceEnds : response.paidThrough;
  if (!response.entitled || deadline === null) return null;
  const parsed = Date.parse(deadline);
  return Number.isFinite(parsed) ? parsed : null;
}

export function assertAccessCurrent(
  response: EntitlementResponse,
  nowMs: number,
): void {
  if (!response.entitled) return;
  const deadlineMs = accessDeadlineMs(response);
  if (!Number.isFinite(nowMs) || deadlineMs === null || nowMs > deadlineMs) {
    throw new EntitlementVerificationError();
  }
}
