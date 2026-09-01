import type {
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";

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

export interface FastifyStremioProtection {
  authorization(request: FastifyRequest): AuthorizedStremioRequest;
  readonly preHandler: preHandlerAsyncHookHandler;
}

export interface FastifyStremioProtectionOptions {
  readonly access: StremioAccessConfiguration;
  readonly mountPath?: string;
  readonly verifier: Pick<AddonPassVerifier, "verifyToken">;
}

async function send(reply: FastifyReply, response: Response): Promise<void> {
  reply.code(response.status);
  response.headers.forEach((value, name) => {
    void reply.header(name, value);
  });
  if (response.body === null || reply.request.method === "HEAD") {
    await reply.send();
    return;
  }
  await reply.send(Buffer.from(await response.arrayBuffer()));
}

export function createFastifyStremioProtection(
  options: FastifyStremioProtectionOptions,
): FastifyStremioProtection {
  const authorizations = new WeakMap<
    FastifyRequest,
    AuthorizedStremioRequest
  >();
  const mountPath = options.mountPath ?? "/addonpass";
  const responder = createStremioAccessResponder(options.access);
  return {
    authorization(request) {
      const authorization = authorizations.get(request);
      if (authorization === undefined) throw new EntitlementVerificationError();
      return authorization;
    },
    async preHandler(request, reply) {
      if (request.method === "OPTIONS") {
        await send(reply, responder.options());
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        await send(reply, responder.methodNotAllowed());
        return;
      }
      try {
        const url = new URL(request.raw.url ?? "/", "http://addonpass.local");
        const authorization = await authorizeStremioRequest(
          options.verifier,
          url,
          mountPath,
        );
        if (!authorization.decision.entitled) {
          await send(reply, responder.denied(authorization));
          return;
        }
        authorizations.set(request, authorization);
        request.raw.url = `${authorization.route.upstreamPath}${url.search}`;
        void reply.header("access-control-allow-origin", "*");
      } catch (error: unknown) {
        if (
          error instanceof UnsupportedStremioRouteError ||
          error instanceof InvalidEntitlementTokenError
        ) {
          await send(reply, responder.invalid());
          return;
        }
        if (
          error instanceof AddonPassUnavailableError ||
          error instanceof EntitlementCredentialRejectedError ||
          error instanceof EntitlementScopeMismatchError ||
          error instanceof EntitlementVerificationError
        ) {
          await send(reply, responder.unavailable());
          return;
        }
        throw error;
      }
    },
  };
}
