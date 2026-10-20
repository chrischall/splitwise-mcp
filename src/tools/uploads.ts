import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult } from '@chrischall/mcp-utils';
import type { SplitwiseClient } from '../client.js';
import { blobStoreFromEnv } from '@chrischall/mcp-utils/export';
import { canonicalReceiptMime, MAX_RECEIPT_BYTES, safeKeyName } from './_receipt.js';

/** Long enough to run a curl in the same turn, short enough that a leaked link is soon dead. */
export const UPLOAD_URL_TTL_MS = 10 * 60 * 1000;

/**
 * `sw_get_upload_url` — get a receipt's bytes to the server without passing
 * them through the model. A hosted server cannot read the caller's files
 * (receipt.path is off) and base64 costs ~1.37 bytes of context per byte of
 * image; a signed PUT moves the original file with one curl. Always
 * registered, so the tool list is the same everywhere; on a server with no
 * blob store it says which receipt source to use instead.
 */
export function registerUploadTools(server: McpServer, _client: SplitwiseClient): void {
  server.registerTool(
    'sw_get_upload_url',
    {
      description:
        'Get a short-lived (~10 min) signed URL to upload a receipt file (PNG, JPEG, GIF or PDF, up to 10 MiB) to this server WITHOUT putting its bytes in a tool call: run the returned curl command from a shell or sandbox that has the file and network access to the URL\'s host, then pass receipt: {upload_id, filename} to sw_attach_receipt, sw_create_expense or sw_update_expense. Send the original file — no need to shrink it. Only on the hosted server; locally use receipt.path. If you have no shell that can reach the URL, use receipt.base64 instead.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({
        filename: z.string().min(1).max(200).describe('Name of the file, e.g. "receipt.jpg"'),
        content_type: z
          .string()
          .describe('The file\'s type: image/png, image/jpeg, image/gif or application/pdf. The upload must send exactly this Content-Type.'),
      }),
    },
    async ({ filename, content_type }) => {
      const store = blobStoreFromEnv();
      if (!store) {
        throw new Error(
          'sw_get_upload_url only works on the hosted server (no blob store is configured here). Pass the file as receipt.path (a file inside SPLITWISE_INPUT_DIR) or receipt.base64 instead.',
        );
      }
      const contentType = canonicalReceiptMime(content_type);
      const key = `up/${randomUUID()}/${safeKeyName(filename)}`;
      const { url: uploadUrl, expiresAtMs: exp } = store.signPutUrl(key, contentType, { ttlMs: UPLOAD_URL_TTL_MS });
      return minifiedResult({
        upload_id: key,
        upload_url: uploadUrl,
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        max_bytes: MAX_RECEIPT_BYTES,
        expires_at: new Date(exp).toISOString(),
        curl: `curl -sS -f -X PUT -H "Content-Type: ${contentType}" --data-binary @<path-to-file> "${uploadUrl}"`,
        next: `After the upload succeeds, pass receipt: {"upload_id": "${key}", "filename": "${safeKeyName(filename)}"} to sw_attach_receipt (or sw_create_expense / sw_update_expense).`,
      });
    },
  );
}
