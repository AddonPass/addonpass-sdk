import type { RequestHandler, Response as ExpressResponse } from "express";

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
} from "./stremio.js";
import type { AddonPassVerifier } from "./verifier.js";

export const EXPRESS_ADDONPASS_LOCAL = "addonPass";

export interface ExpressStremioMiddlewareOptions {
  readonly access: StremioAccessConfiguration;
  readonly mountPath?: string;
  readonly verifier: Pick<AddonPassVerifier, "verifyToken">;
}

async function send(
  target: ExpressResponse,
  response: Response,
  head: boolean,
): Promise<void> {
  target.status(response.status);
  response.headers.forEach((value, name) => {
    target.setHeader(name, value);
  });
  if (head || response.body === null) {
    target.end();
    return;
  }
  target.send(Buffer.from(await response.arrayBuffer()));
}

export function createExpressStremioMiddleware(
  options: ExpressStremioMiddlewareOptions,
): RequestHandler {
  const responder = createStremioAccessResponder(options.access);
  const mountPath = options.mountPath ?? "/addonpass";
  return async (request, response, next) => {
    if (request.method === "OPTIONS") {
      await send(response, responder.options(), false);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      await send(response, responder.methodNotAllowed(), false);
      return;
    }
    try {
      const url = new URL(request.originalUrl, "http://addonpass.local");
      const authorization = await authorizeStremioRequest(
        options.verifier,
        url,
        mountPath,
      );
      if (!authorization.decision.entitled) {
        await send(
          response,
          responder.denied(authorization),
          request.method === "HEAD",
        );
        return;
      }
      const safeUrl = `${authorization.route.upstreamPath}${url.search}`;
      request.url = safeUrl;
      request.originalUrl = safeUrl;
      response.locals[EXPRESS_ADDONPASS_LOCAL] = authorization;
      response.setHeader("access-control-allow-origin", "*");
      next();
    } catch (error: unknown) {
      if (
        error instanceof UnsupportedStremioRouteError ||
        error instanceof InvalidEntitlementTokenError
      ) {
        await send(response, responder.invalid(), request.method === "HEAD");
        return;
      }
      if (
        error instanceof AddonPassUnavailableError ||
        error instanceof EntitlementCredentialRejectedError ||
        error instanceof EntitlementScopeMismatchError ||
        error instanceof EntitlementVerificationError
      ) {
        await send(
          response,
          responder.unavailable(),
          request.method === "HEAD",
        );
        return;
      }
      next(error);
    }
  };
}

export function expressAddonPassAuthorization(
  response: ExpressResponse,
): AuthorizedStremioRequest {
  const authorization = response.locals[EXPRESS_ADDONPASS_LOCAL] as
    AuthorizedStremioRequest | undefined;
  if (authorization === undefined) throw new EntitlementVerificationError();
  return authorization;
}
