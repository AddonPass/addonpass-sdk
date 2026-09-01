import {
  AddonPassConfigurationError,
  UnsupportedStremioRouteError,
} from "./errors.js";
import type { AddonPassVerifier } from "./verifier.js";
import type { EntitlementDecision } from "./types.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ADDON_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,99}$/;
const RESOURCE_NAMES = new Set(["catalog", "meta", "stream"]);
const MAX_PATH_LENGTH = 4_096;

export type StremioResource = "catalog" | "manifest" | "meta" | "stream";

export interface StremioRoute {
  readonly id: string | null;
  readonly resource: StremioResource;
  readonly type: string | null;
  readonly upstreamPath: string;
}

export interface AuthorizedStremioRequest {
  readonly decision: EntitlementDecision;
  readonly route: StremioRoute;
}

export interface StremioAccessConfiguration {
  readonly addonId: string;
  readonly addonName: string;
  readonly managementUrl: string;
}

export interface StremioAccessResponder {
  denied(authorization: AuthorizedStremioRequest): Response;
  invalid(): Response;
  methodNotAllowed(): Response;
  options(): Response;
  unavailable(route?: StremioRoute): Response;
}

function normalizeMountPath(value: string): string {
  if (value === "/") return "";
  if (
    !value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes("\\") ||
    value.includes("%")
  ) {
    throw new AddonPassConfigurationError();
  }
  const segments = value.slice(1).split("/");
  if (
    segments.some(
      (segment) => segment === "." || segment === ".." || segment === "",
    )
  ) {
    throw new AddonPassConfigurationError();
  }
  return value;
}

function safeSegment(value: string): boolean {
  if (value === "" || value.length > 1_024 || /%2f|%5c/i.test(value))
    return false;
  try {
    const decoded = decodeURIComponent(value);
    return (
      decoded !== "." &&
      decoded !== ".." &&
      !decoded.includes("/") &&
      !decoded.includes("\\")
    );
  } catch {
    return false;
  }
}

function parseRoute(
  pathname: string,
  mountPath: string,
): {
  readonly route: StremioRoute;
  readonly token: string;
} {
  if (pathname.length > MAX_PATH_LENGTH)
    throw new UnsupportedStremioRouteError();
  const prefix = `${mountPath}/`;
  if (!pathname.startsWith(prefix)) throw new UnsupportedStremioRouteError();
  const protectedPath = pathname.slice(prefix.length);
  const separator = protectedPath.indexOf("/");
  if (separator === -1) throw new UnsupportedStremioRouteError();
  const token = protectedPath.slice(0, separator);
  if (!TOKEN_PATTERN.test(token)) throw new UnsupportedStremioRouteError();
  const upstreamPath = protectedPath.slice(separator);
  if (upstreamPath === "/manifest.json") {
    return {
      route: {
        id: null,
        resource: "manifest",
        type: null,
        upstreamPath,
      },
      token,
    };
  }
  const segments = upstreamPath.slice(1).split("/");
  if (segments.length < 3 || segments.length > 4) {
    throw new UnsupportedStremioRouteError();
  }
  const [resource, type, id, extra] = segments;
  if (
    resource === undefined ||
    !RESOURCE_NAMES.has(resource) ||
    type === undefined ||
    id === undefined ||
    !safeSegment(type) ||
    !safeSegment(id) ||
    (extra !== undefined && !safeSegment(extra))
  ) {
    throw new UnsupportedStremioRouteError();
  }
  const finalSegment = extra ?? id;
  if (!finalSegment.endsWith(".json") || finalSegment === ".json") {
    throw new UnsupportedStremioRouteError();
  }
  return {
    route: {
      id: id.endsWith(".json") ? id.slice(0, -5) : id,
      resource: resource as Exclude<StremioResource, "manifest">,
      type,
      upstreamPath,
    },
    token,
  };
}

export async function authorizeStremioRequest(
  verifier: Pick<AddonPassVerifier, "verifyToken">,
  url: URL,
  mountPath = "/addonpass",
): Promise<AuthorizedStremioRequest> {
  const parsed = parseRoute(url.pathname, normalizeMountPath(mountPath));
  const decision = await verifier.verifyToken(parsed.token);
  return { decision, route: parsed.route };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status,
  });
}

function responseBody(
  route: StremioRoute,
  config: StremioAccessConfiguration,
  message: string,
): unknown {
  const type = route.type ?? "movie";
  const id = route.id ?? "addonpass-access";
  if (route.resource === "manifest") {
    return {
      catalogs: [{ id: "addonpass-access", name: "Access", type: "movie" }],
      description: message,
      id: `${config.addonId}.access`,
      name: `${config.addonName} access`,
      resources: ["catalog", "meta", "stream"],
      types: ["movie"],
      version: "1.0.0",
    };
  }
  if (route.resource === "catalog") {
    return {
      metas: [
        {
          description: message,
          id: "addonpass:access",
          name: "Manage access",
          type,
        },
      ],
    };
  }
  if (route.resource === "meta") {
    return {
      meta: {
        description: message,
        id,
        links: [
          {
            category: "addonpass",
            name: "Manage access",
            url: config.managementUrl,
          },
        ],
        name: "Manage access",
        type,
      },
    };
  }
  return {
    streams: [
      {
        description: message,
        externalUrl: config.managementUrl,
        name: "Manage access",
      },
    ],
  };
}

function denialMessage(decision: EntitlementDecision): string {
  switch (decision.status) {
    case "authorization_ended":
      return "This subscription has used its authorized charges. Resume it to continue.";
    case "cancelled":
      return "This subscription is cancelled and its paid access has ended.";
    case "expired":
      return "Payment access has expired. Manage the subscription to continue.";
    case "not_found":
      return "This installation link is invalid or no longer active.";
    case "active":
    case "grace":
      return "Access is available.";
  }
}

export function createStremioAccessResponder(
  config: StremioAccessConfiguration,
): StremioAccessResponder {
  let managementUrl: URL;
  try {
    managementUrl = new URL(config.managementUrl);
  } catch {
    throw new AddonPassConfigurationError();
  }
  const localHttp =
    managementUrl.protocol === "http:" &&
    (managementUrl.hostname === "localhost" ||
      managementUrl.hostname === "127.0.0.1");
  if (
    !ADDON_ID_PATTERN.test(config.addonId) ||
    config.addonName.trim() === "" ||
    config.addonName.length > 100 ||
    (managementUrl.protocol !== "https:" && !localHttp) ||
    managementUrl.username !== "" ||
    managementUrl.password !== ""
  ) {
    throw new AddonPassConfigurationError();
  }
  const normalized = {
    addonId: config.addonId,
    addonName: config.addonName.trim(),
    managementUrl: managementUrl.toString(),
  };
  return {
    denied(authorization) {
      return jsonResponse(
        responseBody(
          authorization.route,
          normalized,
          denialMessage(authorization.decision),
        ),
        authorization.decision.status === "not_found" ? 404 : 200,
      );
    },
    invalid() {
      return jsonResponse({ error: "access_denied" }, 404);
    },
    methodNotAllowed() {
      const response = jsonResponse({ error: "method_not_allowed" }, 405);
      response.headers.set("allow", "GET, HEAD, OPTIONS");
      return response;
    },
    options() {
      return new Response(null, {
        headers: {
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        },
        status: 204,
      });
    },
    unavailable(route) {
      return route === undefined
        ? jsonResponse({ error: "verification_unavailable" }, 503)
        : jsonResponse(
            responseBody(
              route,
              normalized,
              "Access could not be checked. Try again shortly.",
            ),
            503,
          );
    },
  };
}
