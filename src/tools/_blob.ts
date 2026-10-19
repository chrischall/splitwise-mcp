import { createHmac } from 'crypto';
import { readEnvVar } from '@chrischall/mcp-utils';

/**
 * mcp-host's shared blob store (mcp-host `docs/BLOB-STORE.md`). A hosted child
 * is handed `MCP_BLOB_BASE_URL` (`https://<host>/b/<registrationId>`) and its
 * own derived `MCP_BLOB_SIGNING_KEY`; a stdio server has neither, and that
 * absence is what turns the upload route off.
 *
 * The payload shapes are the gateway's, byte for byte — do not "tidy" them:
 *
 *   GET  signs  <registrationId>/<key>\n<exp>
 *   PUT  signs  put\0<registrationId>/<key>\0<contentType>\0<exp>
 *
 * The PUT signature commits to the content type, so a URL minted for a PNG
 * cannot store anything else, and a read signature can never be replayed as a
 * write.
 */
export interface BlobConfig {
  base: string;
  /** The `<registrationId>` the gateway folds into every signed key. */
  prefix: string;
  signingKey: string;
}

export function blobConfig(): BlobConfig | undefined {
  const baseUrl = readEnvVar('MCP_BLOB_BASE_URL');
  const signingKey = readEnvVar('MCP_BLOB_SIGNING_KEY');
  if (!baseUrl || !signingKey) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`MCP_BLOB_BASE_URL is not a valid URL — it should look like https://<host>/b/<registrationId>`);
  }
  const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
  const prefix = path.startsWith('b/') ? path.slice(2) : path;
  return { base: baseUrl.replace(/\/+$/, ''), prefix, signingKey };
}

const sign = (cfg: BlobConfig, payload: string) =>
  createHmac('sha256', cfg.signingKey).update(payload).digest('base64url');

function url(cfg: BlobConfig, key: string, exp: number, sig: string): string {
  return `${cfg.base}/${key}?exp=${exp}&sig=${encodeURIComponent(sig)}`;
}

export function signedPutUrl(cfg: BlobConfig, key: string, contentType: string, exp: number): string {
  return url(cfg, key, exp, sign(cfg, `put\0${cfg.prefix}/${key}\0${contentType}\0${exp}`));
}

export function signedGetUrl(cfg: BlobConfig, key: string, exp: number): string {
  return url(cfg, key, exp, sign(cfg, `${cfg.prefix}/${key}\n${exp}`));
}

/**
 * The only keys `receipt.upload_id` may name: `up/<uuid>/<safe name>`, exactly
 * what `sw_get_upload_url` mints. Anything else in this registration's space
 * is not the caller's to read through a receipt.
 */
export const UPLOAD_ID_PATTERN = /^up\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

/** A filename made safe for a key segment: no separators, no dot-dot, no surprises. */
export function safeKeyName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 100);
  return cleaned || 'receipt';
}
