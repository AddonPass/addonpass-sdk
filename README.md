# AddonPass middleware SDK

`@addon-pass/sdk` protects private Stremio JSON routes in the same process as the add-on handlers.

The SDK is currently a Base Sepolia `0.x` release. Install the reviewed public
package directly:

```sh
pnpm add @addon-pass/sdk@0.1.3
```

The public SDK repository contains only middleware source. The AddonPass
application, deployment configuration, credentials, and Sepolia contract source
remain private.

## Request boundary

For a request such as:

```text
/addonpass/{token}/stream/movie/addonpass:reference-film.json
```

the middleware:

1. accepts only a canonical 43-character, unpadded base64url token containing 32 bytes;
2. hashes the decoded bytes locally with Ethereum `keccak256`;
3. sends only the hash to `POST /v1/entitlements/verify` with the add-on-scoped integration credential;
4. checks the returned plan against the configured allowlist;
5. removes the bearer-token prefix before the add-on handler runs; and
6. serves the add-on response only for active or grace access.

The raw token is never sent to AddonPass. Do not log request URLs, attach third-party analytics to protected routes, or expose the same handlers on another path, port, or hostname.

## Supported adapters

- Framework-neutral Fetch handler: `createFetchStremioHandler`
- Native Node HTTP handler: `createNodeStremioHandler`
- Express 5 middleware: `@addon-pass/sdk/express`
- Fastify 5 pre-handler: `@addon-pass/sdk/fastify`

The framework packages are optional peers. Import only the adapter used by the add-on.

## Native Node example

```ts
import { createServer } from "node:http";

import {
  AddonPassVerifier,
  createNodeStremioHandler,
} from "@addon-pass/sdk";

const verifier = new AddonPassVerifier({
  allowedPlanIds: ["PLAN_ID"],
  apiBaseUrl: "https://api.addonpass.example",
  integrationCredential: "ADDON_SCOPED_CREDENTIAL",
});

The AddonPass integration test subscribes with a hidden test plan that reports no plan id, so it passes regardless of `allowedPlanIds`.

const handle = createNodeStremioHandler({
  access: {
    addonId: "com.example.private-addon",
    addonName: "Private Add-on",
    managementUrl: "https://addonpass.example/subscriptions",
  },
  verifier,
  upstream: async (request, authorization) => {
    // request.url now contains /manifest.json or the normal Stremio resource
    // path. authorization contains the verified decision and parsed route, but
    // never the raw bearer token.
    return Response.json({
      resource: authorization.route.resource,
      path: new URL(request.url).pathname,
    });
  },
});

createServer((request, response) => {
  void handle(request, response);
}).listen(3002, "127.0.0.1");
```

Use placeholders in source control. Load the API URL, plan IDs, management URL, and integration credential from the add-on process environment.

## Express and Fastify

Mount the Express middleware globally before every add-on handler. The middleware rejects `/manifest.json` without a token and rewrites an entitled request before Express performs downstream routing.

```ts
import express from "express";
import {
  createExpressStremioMiddleware,
  expressAddonPassAuthorization,
} from "@addon-pass/sdk/express";

const app = express();
app.use(createExpressStremioMiddleware({ access, verifier }));
app.get("/manifest.json", (_request, response) => {
  const authorization = expressAddonPassAuthorization(response);
  response.json(buildManifest(authorization));
});
```

For Fastify, attach the same protection instance to every protected route and read the request-scoped result from it.

```ts
import { createFastifyStremioProtection } from "@addon-pass/sdk/fastify";

const protection = createFastifyStremioProtection({ access, verifier });
app.get(
  "/addonpass/:token/manifest.json",
  { preHandler: protection.preHandler },
  (request) => buildManifest(protection.authorization(request)),
);
```

Do not register an unprotected copy of either handler.

## Verification behavior

| State | Result |
| --- | --- |
| Active or grace | Invoke the add-on handler and return its Stremio JSON. |
| Expired, cancelled, or authorization ended | Return valid Stremio JSON with the configured management URL; do not invoke the add-on. |
| Unknown or malformed token | Return a generic `404` without disclosing entitlement state. |
| API network error or `5xx` | Use the optional safe-block contract fallback when configured; otherwise return `503`. |
| Rejected credential, scope mismatch, or invalid API response | Fail closed. These errors never activate contract fallback. |

Successful API decisions use a bounded in-memory LRU cache. Its TTL is at most five seconds and is shortened so it can never extend access beyond paid-through or grace.

## Direct contract fallback

`createViemEntitlementFallback` reads the configured non-upgradeable contract at one safe block and cross-checks the stored subscription, hash, developer, chain, and plan scope. It is opt-in. Configure a bounded RPC transport and never treat a credential rejection as an API outage.

Use the same verifier instance for every protected route and keep its integration
credential in the add-on server environment.

## Local verification

```sh
npm install
npm run check
```

The suites cover active, grace, terminal, malformed-token, unavailable-provider, cache, fallback, CORS, route-scrubbing, and unprotected-route denial behavior using controlled entitlement decisions. They do not replace the required deployed positive-entitlement integration proof before checkout publication.
