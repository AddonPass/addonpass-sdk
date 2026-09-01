import {
  AddonPassUnavailableError,
  EntitlementCredentialRejectedError,
  EntitlementScopeMismatchError,
  EntitlementVerificationError,
  InvalidEntitlementTokenError,
  UnsupportedStremioRouteError,
} from "./errors.js";
import {
  authorizeStremioRequest,
  createStremioAccessResponder,
  type AuthorizedStremioRequest,
  type StremioAccessConfiguration,
  type StremioRoute,
} from "./stremio.js";
import type { AddonPassVerifier } from "./verifier.js";

export type FetchStremioUpstream = (
  request: Request,
  authorization: AuthorizedStremioRequest,
) => Promise<Response> | Response;

export interface FetchStremioHandlerOptions {
  readonly access: StremioAccessConfiguration;
  readonly mountPath?: string;
  readonly upstream: FetchStremioUpstream;
  readonly verifier: Pick<AddonPassVerifier, "verifyToken">;
}

function withCors(response: Response, head: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  return new Response(head ? null : response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function createFetchStremioHandler(
  options: FetchStremioHandlerOptions,
): (request: Request) => Promise<Response> {
  const responder = createStremioAccessResponder(options.access);
  const mountPath = options.mountPath ?? "/addonpass";
  return async (request) => {
    if (request.method === "OPTIONS") return responder.options();
    if (request.method !== "GET" && request.method !== "HEAD") {
      return responder.methodNotAllowed();
    }
    let route: StremioRoute | undefined;
    try {
      const url = new URL(request.url);
      const authorization = await authorizeStremioRequest(
        options.verifier,
        url,
        mountPath,
      );
      route = authorization.route;
      if (!authorization.decision.entitled) {
        return withCors(
          responder.denied(authorization),
          request.method === "HEAD",
        );
      }
      url.pathname = authorization.route.upstreamPath;
      const upstreamRequest = new Request(url, request);
      return withCors(
        await options.upstream(upstreamRequest, authorization),
        request.method === "HEAD",
      );
    } catch (error: unknown) {
      if (
        error instanceof UnsupportedStremioRouteError ||
        error instanceof InvalidEntitlementTokenError
      ) {
        return withCors(responder.invalid(), request.method === "HEAD");
      }
      if (
        error instanceof AddonPassUnavailableError ||
        error instanceof EntitlementCredentialRejectedError ||
        error instanceof EntitlementScopeMismatchError ||
        error instanceof EntitlementVerificationError
      ) {
        return withCors(
          responder.unavailable(route),
          request.method === "HEAD",
        );
      }
      throw error;
    }
  };
}
