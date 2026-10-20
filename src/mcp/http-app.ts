import express, { type Express } from 'express';
import {
  hostHeaderValidation,
  localhostHostValidation,
} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';

// Issue #588: SDK 1.32.1 createMcpExpressApp() unconditionally installs
// express.json() with the 100 KiB default. A 221 KiB file encoded as Base64
// therefore fails HTTP 413 *before* Nexowire authentication or MCP routing.
//
// Keep the upstream Host-header/DNS-rebinding middleware and its ordering
// unchanged. The deliberate 512 KiB request-body cap is NOT an unlimited
// transfer mechanism; multi-GB files must use durable, bounded streaming.
export const NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES = 512 * 1024;

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

  // Host check first, bounded parsing second. express.json() defaults to
  // 100 KiB; setting a finite 512 KiB cap accommodates a ~230 KiB binary file
  // encoded as Base64 without relaxing per-request safety into unbounded RAM.
  app.use(express.json({ limit: NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES }));
  return app;
}
