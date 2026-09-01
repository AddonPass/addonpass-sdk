import type { Hex } from "viem";

import {
  AddonPassConfigurationError,
  AddonPassUnavailableError,
  EntitlementCredentialRejectedError,
  EntitlementScopeMismatchError,
  EntitlementVerificationError,
} from "./errors.js";
import { hashEntitlementToken } from "./token.js";
import {
  entitlementResponseSchema,
  type EntitlementDecision,
  type EntitlementFallback,
  type EntitlementResponse,
} from "./types.js";

const CREDENTIAL_PATTERN =
  /^ap_v[1-9][0-9]*_[a-z0-9]{10,24}\.[A-Za-z0-9_-]{43}$/;
const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_MAX_CACHE_ENTRIES = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const MAX_CACHE_TTL_MS = 5_000;
const MAX_RESPONSE_BYTES = 16_384;

interface CacheEntry {
  readonly decision: EntitlementDecision;
  readonly expiresAtMs: number;
}

interface ApiVerification {
  readonly cacheTtlMs: number;
  readonly response: EntitlementResponse;
}

class ApiUnavailableError extends Error {}

function normalizedApiUrl(value: string): URL {
  try {
    const url = new URL(value);
    const localHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (
      (url.protocol !== "https:" && !localHttp) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new AddonPassConfigurationError();
    }
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return new URL("v1/entitlements/verify", url);
  } catch (error: unknown) {
    if (error instanceof AddonPassConfigurationError) throw error;
    throw new AddonPassConfigurationError();
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) ||
    selected < minimum ||
    selected > maximum
  ) {
    throw new AddonPassConfigurationError();
  }
  return selected;
}

function cacheControlTtl(value: string | null): number {
  if (value === null || /(?:^|,)\s*no-store\s*(?:,|$)/i.test(value)) return 0;
  const match = /(?:^|,)\s*max-age=([0-9]+)\s*(?:,|$)/i.exec(value);
  if (match?.[1] === undefined) return 0;
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds) ? seconds * 1_000 : 0;
}

async function readBoundedBody(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new EntitlementVerificationError();
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let chunk = await reader.read();
  while (!chunk.done) {
    bytes += chunk.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new EntitlementVerificationError();
    }
    text += decoder.decode(chunk.value, { stream: true });
    chunk = await reader.read();
  }
  return text + decoder.decode();
}

function accessDeadlineMs(response: EntitlementResponse): number | null {
  const deadline =
    response.status === "grace" ? response.graceEnds : response.paidThrough;
  if (!response.entitled || deadline === null) return null;
  const parsed = Date.parse(deadline);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface AddonPassVerifierOptions {
  readonly allowedPlanIds: readonly (bigint | string)[];
  readonly apiBaseUrl: string;
  readonly cacheTtlMs?: number;
  readonly fallback?: EntitlementFallback;
  readonly fetch?: typeof globalThis.fetch;
  readonly integrationCredential: string;
  readonly maxCacheEntries?: number;
  readonly now?: () => Date;
  readonly requestTimeoutMs?: number;
}

export class AddonPassVerifier {
  readonly #allowedPlanIds: ReadonlySet<string>;
  readonly #apiUrl: URL;
  readonly #cache = new Map<Hex, CacheEntry>();
  readonly #cacheTtlMs: number;
  readonly #fallback: EntitlementFallback | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #inFlight = new Map<Hex, Promise<EntitlementDecision>>();
  readonly #integrationCredential: string;
  readonly #maxCacheEntries: number;
  readonly #now: () => Date;
  readonly #requestTimeoutMs: number;

  constructor(options: AddonPassVerifierOptions) {
    this.#apiUrl = normalizedApiUrl(options.apiBaseUrl);
    if (!CREDENTIAL_PATTERN.test(options.integrationCredential)) {
      throw new AddonPassConfigurationError();
    }
    const allowedPlanIds = options.allowedPlanIds.map((value) =>
      value.toString(),
    );
    if (
      allowedPlanIds.length === 0 ||
      allowedPlanIds.some((value) => !/^[1-9][0-9]*$/.test(value))
    ) {
      throw new AddonPassConfigurationError();
    }
    this.#allowedPlanIds = new Set(allowedPlanIds);
    this.#cacheTtlMs = boundedInteger(
      options.cacheTtlMs,
      DEFAULT_CACHE_TTL_MS,
      0,
      MAX_CACHE_TTL_MS,
    );
    this.#maxCacheEntries = boundedInteger(
      options.maxCacheEntries,
      DEFAULT_MAX_CACHE_ENTRIES,
      1,
      10_000,
    );
    this.#requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      100,
      10_000,
    );
    this.#fallback = options.fallback;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#integrationCredential = options.integrationCredential;
    this.#now = options.now ?? (() => new Date());
  }

  clear(): void {
    this.#cache.clear();
  }

  invalidate(rawToken: string): void {
    this.#cache.delete(hashEntitlementToken(rawToken));
  }

  async verifyToken(rawToken: string): Promise<EntitlementDecision> {
    const tokenHash = hashEntitlementToken(rawToken);
    const nowMs = this.#now().getTime();
    const cached = this.#cache.get(tokenHash);
    if (cached !== undefined) {
      if (cached.expiresAtMs > nowMs) {
        this.#cache.delete(tokenHash);
        this.#cache.set(tokenHash, cached);
        return { ...cached.decision, cached: true };
      }
      this.#cache.delete(tokenHash);
    }
    const active = this.#inFlight.get(tokenHash);
    if (active !== undefined) return active;
    const verification = this.#verify(tokenHash).finally(() => {
      this.#inFlight.delete(tokenHash);
    });
    this.#inFlight.set(tokenHash, verification);
    return verification;
  }

  async #verify(tokenHash: Hex): Promise<EntitlementDecision> {
    let verification: ApiVerification;
    let source: EntitlementDecision["source"] = "api";
    try {
      verification = await this.#verifyViaApi(tokenHash);
    } catch (error: unknown) {
      if (
        !(error instanceof ApiUnavailableError) ||
        this.#fallback === undefined
      ) {
        throw error instanceof ApiUnavailableError
          ? new AddonPassUnavailableError()
          : error;
      }
      let response: EntitlementResponse;
      try {
        response = entitlementResponseSchema.parse(
          await this.#fallback.verify(tokenHash),
        );
      } catch (fallbackError: unknown) {
        if (fallbackError instanceof EntitlementScopeMismatchError) {
          throw fallbackError;
        }
        throw new AddonPassUnavailableError();
      }
      verification = { cacheTtlMs: this.#cacheTtlMs, response };
      source = "contract";
    }
    if (
      verification.response.planId !== null &&
      !this.#allowedPlanIds.has(verification.response.planId)
    ) {
      throw new EntitlementScopeMismatchError();
    }
    const decision: EntitlementDecision = {
      ...verification.response,
      cached: false,
      source,
    };
    this.#cacheDecision(tokenHash, decision, verification.cacheTtlMs);
    return decision;
  }

  async #verifyViaApi(tokenHash: Hex): Promise<ApiVerification> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.#requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await this.#fetch(this.#apiUrl, {
          body: JSON.stringify({ tokenHash }),
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.#integrationCredential}`,
            "content-type": "application/json",
          },
          method: "POST",
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw new ApiUnavailableError();
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new EntitlementCredentialRejectedError();
      }
      if (response.status >= 500) {
        await response.body?.cancel();
        throw new ApiUnavailableError();
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new EntitlementVerificationError();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBoundedBody(response));
      } catch (error: unknown) {
        if (controller.signal.aborted) throw new ApiUnavailableError();
        if (error instanceof EntitlementVerificationError) throw error;
        throw new EntitlementVerificationError();
      }
      const result = entitlementResponseSchema.safeParse(parsed);
      if (!result.success) throw new EntitlementVerificationError();
      return {
        cacheTtlMs: Math.min(
          this.#cacheTtlMs,
          cacheControlTtl(response.headers.get("cache-control")),
        ),
        response: result.data,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  #cacheDecision(
    tokenHash: Hex,
    decision: EntitlementDecision,
    requestedTtlMs: number,
  ): void {
    const nowMs = this.#now().getTime();
    const deadlineMs = accessDeadlineMs(decision);
    const ttlMs = Math.max(
      0,
      Math.min(
        requestedTtlMs,
        deadlineMs === null ? requestedTtlMs : deadlineMs - nowMs,
      ),
    );
    if (ttlMs === 0) return;
    while (this.#cache.size >= this.#maxCacheEntries) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    this.#cache.set(tokenHash, {
      decision,
      expiresAtMs: nowMs + ttlMs,
    });
  }
}
