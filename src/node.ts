import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  createFetchStremioHandler,
  type FetchStremioHandlerOptions,
} from "./fetch.js";

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

async function writeResponse(
  request: IncomingMessage,
  target: ServerResponse,
  response: Response,
): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => {
    target.setHeader(name, value);
  });
  if (request.method === "HEAD" || response.body === null) {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  let chunk = await reader.read();
  while (!chunk.done) {
    if (!target.write(Buffer.from(chunk.value))) await once(target, "drain");
    chunk = await reader.read();
  }
  target.end();
}

export function createNodeStremioHandler(
  options: FetchStremioHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const handle = createFetchStremioHandler(options);
  return async (request, response) => {
    try {
      const result = await handle(
        new Request(new URL(request.url ?? "/", "http://addonpass.local"), {
          headers: requestHeaders(request),
          method: request.method ?? "GET",
        }),
      );
      await writeResponse(request, response, result);
    } catch {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.statusCode = 500;
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end('{"error":"addon_unavailable"}');
    }
  };
}
