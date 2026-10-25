// How the MCP HTTP routes answer (RFC 0003 section 10): a JSON body that,
// as on `/qd`, no cache keeps and no browser reads as anything but JSON
// (TRANSPORT-3), or 202 with no body; and a client that goes away before
// its answer cancels its call.

import type { ServerResponse } from "node:http";

function ended(res: ServerResponse): boolean {
  return res.headersSent || res.writableEnded || res.destroyed;
}

/** Writes a JSON body, unless the response already ended; returns its size in bytes. */
export function send(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): number | undefined {
  if (ended(res)) {
    return undefined;
  }
  const bytes = Buffer.byteLength(body);
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", bytes);
  // As on `/qd`: a caller's data is never cached, nor read as anything but JSON (TRANSPORT-3).
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
  return bytes;
}

/** Answers 202 Accepted with no body, unless the response already ended. */
export function accepted(res: ServerResponse): void {
  if (ended(res)) {
    return;
  }
  res.statusCode = 202;
  res.setHeader("content-length", 0);
  res.setHeader("cache-control", "no-store");
  res.end();
}

/** A signal that aborts when the client goes away before its response was sent: the call's cancel. */
export function abortOnClose(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  // `req` closes once its body was read; `res` closes when the client leaves.
  res.once("close", () => {
    if (!res.writableFinished) {
      controller.abort();
    }
  });
  return controller.signal;
}
