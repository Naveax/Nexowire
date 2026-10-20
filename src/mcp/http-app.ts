import express, { type Express } from 'express';
import {
  hostHeaderValidation,
  localhostHostValidation,
} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';

// Issue #588: the upstream SDK factory installs express.json() at a 100 KiB
// default. Keep Host/DNS-rebinding validation before parsing while bounding
// *each* incoming JSON body and each outgoing HTTP MCP body to 9.5 MiB.
// These are transport envelopes, not a GB-file-transfer protocol.
// Raw binary carried inside Base64 JSON has less usable capacity.
export const NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES = 19 * 1024 * 1024 / 2;
export const NEXOWIRE_MCP_RESPONSE_BODY_LIMIT_BYTES = 19 * 1024 * 1024 / 2;

function responseChunkBytes(chunk: unknown, encoding?: unknown): number {
  if (typeof chunk === 'string') {
    return Buffer.byteLength(
      chunk,
      typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8',
    );
  }
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

export function createNexowireMcpExpressApp(
  options: { host: string; allowedHosts?: string[] },
): Express {
  const app = express();
  if (options.allowedHosts) {
    app.use(hostHeaderValidation(options.allowedHosts));
  } else if (['127.0.0.1', 'localhost', '::1'].includes(options.host)) {
    app.use(localhostHostValidation());
  } else if (options.host === '0.0.0.0' || options.host === '::') {
    // Preserve the upstream factory's bind-all-interface warning.
    console.warn(
      `Warning: Server is binding to ${options.host} without DNS rebinding protection. ` +
      'Consider using the allowedHosts option to restrict allowed hosts, ' +
      'or use authentication to protect your server.',
    );
  }

  // Bind finite output accounting to the /mcp path only. MCP tool responses
  // may use res.end() or multiple res.write() SSE chunks. Never silently
  // truncate a successful mutation result: on overflow before headers send an
  // explicit UNKNOWN status (no automatic replay); after streaming has started
  // abort the connection rather than emitting a forged successful trailer.
  app.use('/mcp', (_req, res, next) => {
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    let outputBytes = 0;
    let rejected = false;

    const rejectOversizedResponse = (): void => {
      if (rejected) return;
      rejected = true;
      res.write = originalWrite;
      res.end = originalEnd;
      if (res.headersSent) {
        res.destroy(new Error('NEXOWIRE_MCP_RESPONSE_TOO_LARGE'));
        return;
      }
      res.removeHeader('Content-Length');
      res.removeHeader('ETag');
      res.status(413);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      originalEnd(JSON.stringify({
        error: 'MCP_RESPONSE_TOO_LARGE',
        code: 'MCP_RESPONSE_TOO_LARGE',
        mutation_state: 'unknown',
        automatically_retryable: false,
        limit_bytes: NEXOWIRE_MCP_RESPONSE_BODY_LIMIT_BYTES,
      }));
    };

    res.write = ((...args: unknown[]) => {
      if (rejected) return false;
      const length = responseChunkBytes(args[0], args[1]);
      if (outputBytes + length > NEXOWIRE_MCP_RESPONSE_BODY_LIMIT_BYTES) {
        rejectOversizedResponse();
        return false;
      }
      outputBytes += length;
      return Reflect.apply(originalWrite, res, args) as boolean;
    }) as typeof res.write;

    res.end = ((...args: unknown[]) => {
      if (rejected) return res;
      const length = responseChunkBytes(args[0], args[1]);
      if (outputBytes + length > NEXOWIRE_MCP_RESPONSE_BODY_LIMIT_BYTES) {
        rejectOversizedResponse();
        return res;
      }
      outputBytes += length;
      return Reflect.apply(originalEnd, res, args) as typeof res;
    }) as typeof res.end;
    next();
  });

  // SDK's original parser ran for every endpoint. The only JSON POST is
  // /mcp; keeping parse admission per-route prevents unauthenticated clients
  // from reserving unlimited 9.5 MiB parser buffers simultaneously.
  // This is a parser-stage guard only: it releases immediately upon parse
  // completion, NOT after a potentially long-running tool/SSE response.
  const jsonParser = express.json({ limit: NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES });
  const MAX_CONCURRENT_MCP_JSON_PARSERS = 4;
  let parsingRequests = 0;
  app.use('/mcp', (req, res, next) => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    if (parsingRequests >= MAX_CONCURRENT_MCP_JSON_PARSERS) {
      res.setHeader('Retry-After', '1');
      res.setHeader('Cache-Control', 'no-store');
      res.status(503).json({
        error: 'MCP_JSON_PARSER_BUSY',
        code: 'MCP_JSON_PARSER_BUSY',
        automatically_retryable: false,
      });
      return;
    }
    parsingRequests += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      parsingRequests -= 1;
    };
    res.once('close', release);
    jsonParser(req, res, (error?: unknown) => {
      release();
      next(error);
    });
  });
  return app;
}
