import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  textResult,
  imageResult,
  resolveOutputDir,
  writeBinaryOutput,
  sniffMimeBytes,
} from '@chrischall/mcp-utils';
import type { SplitwiseClient } from '../client.js';

/** Splitwise's receipt object on an expense — either rendition can be null. */
interface ExpenseReceipt {
  original?: string | null;
  large?: string | null;
}

type ReceiptSize = 'original' | 'large';

/** Cap on bytes returned as base64 in the tool result; the file is written regardless. */
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

/** Content types that carry no information about the actual format. */
const GENERIC_TYPES = new Set(['application/octet-stream', 'binary/octet-stream']);

/** `%PDF-` magic bytes — `sniffMimeBytes` only knows the image formats. */
function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';
}

/**
 * Best-effort MIME type for the downloaded bytes: the response's Content-Type
 * when it says something useful, else the magic bytes, else undefined.
 */
function resolveMimeType(contentType: string | null, bytes: Uint8Array): string | undefined {
  const declared = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (declared && !GENERIC_TYPES.has(declared)) return declared;
  return sniffMimeBytes(bytes) ?? (isPdf(bytes) ? 'application/pdf' : undefined);
}

/** Extension from a URL path (`…/receipt.jpg?sig=…` → `jpg`), when it has one. */
function extensionFromUrl(url: string): string | undefined {
  const match = /\.([a-z0-9]{1,5})$/i.exec(new URL(url).pathname);
  return match ? match[1]!.toLowerCase() : undefined;
}

/**
 * File extension for the receipt: the MIME subtype when it looks like a plain
 * one (`application/pdf` → `pdf`, `image/heic` → `heic`), else the URL's own
 * extension, else `bin`.
 */
function extensionFor(mimeType: string | undefined, url: string): string {
  const subtype = mimeType?.split('/')[1];
  if (subtype === 'jpeg') return 'jpg';
  if (subtype && /^[a-z0-9]{1,5}$/.test(subtype)) return subtype;
  return extensionFromUrl(url) ?? 'bin';
}

export function registerReceiptTools(server: McpServer, client: SplitwiseClient): void {
  server.registerTool('sw_get_receipt', {
    description:
      "Download the receipt image or PDF attached to a Splitwise expense. The receipt URLs returned by sw_get_expense need the server's credentials — fetching them directly returns 401 — so use this tool instead. It writes the authenticated bytes to a file and returns the path; set inline:true to also get an image receipt back in the result. Files go to output_dir, else $SPLITWISE_OUTPUT_DIR, else the current directory, and an existing file is never overwritten.",
    // No remote mutation, and the local write is always to a fresh filename.
    annotations: { readOnlyHint: true },
    inputSchema: {
      id: z.number().describe('Expense ID (the same id sw_get_expense takes)'),
      size: z
        .enum(['original', 'large'])
        .describe("Which stored rendition to fetch. Defaults to 'original' (full quality, and the only one a PDF receipt has). Falls back to the other rendition when the requested one is absent.")
        .optional(),
      output_dir: z
        .string()
        .describe('Directory to write the receipt into. Defaults to $SPLITWISE_OUTPUT_DIR, else the current working directory.')
        .optional(),
      inline: z
        .boolean()
        .describe(`Also return the receipt as a base64 image in the result. Image receipts only, and only under ${MAX_INLINE_BYTES} bytes.`)
        .optional(),
    },
  }, async ({ id, size, output_dir, inline }) => {
    const wanted: ReceiptSize = size ?? 'original';
    const fallback: ReceiptSize = wanted === 'original' ? 'large' : 'original';

    const expense = await client.request<{ expense?: { receipt?: ExpenseReceipt | null } | null }>(
      'GET',
      `/get_expense/${id}`,
    );
    const receipt = expense?.expense?.receipt;
    const url = receipt?.[wanted] || receipt?.[fallback];
    if (!url) {
      throw new Error(`Splitwise expense ${id} has no receipt attached.`);
    }
    const served: ReceiptSize = receipt?.[wanted] ? wanted : fallback;

    const asset = await client.fetchAsset(url);
    if (asset.bytes.length === 0) {
      throw new Error(`Splitwise returned an empty receipt body for expense ${id}.`);
    }

    const mimeType = resolveMimeType(asset.contentType, asset.bytes);
    const base64 = Buffer.from(asset.bytes).toString('base64');
    const path = writeBinaryOutput({
      dir: resolveOutputDir(output_dir, 'SPLITWISE_OUTPUT_DIR'),
      baseName: `splitwise-receipt-${id}`,
      base64,
      extension: extensionFor(mimeType, url),
    });

    const imageMime = mimeType?.startsWith('image/') ? mimeType : undefined;
    const inlined = inline === true && imageMime !== undefined && asset.bytes.length <= MAX_INLINE_BYTES;

    const result = textResult({
      expense_id: id,
      size: served,
      ...(served !== wanted
        ? { requested_size: wanted, note: `Expense ${id} has no ${wanted} rendition; fetched ${served}.` }
        : {}),
      path,
      bytes: asset.bytes.length,
      content_type: mimeType ?? 'unknown',
      // The receipt URL itself is a signed capability, so report only its host.
      source_host: new URL(url).host,
      inline: inlined,
      ...(inline === true && !inlined
        ? {
            inline_skipped: imageMime
              ? `Receipt is ${asset.bytes.length} bytes, over the ${MAX_INLINE_BYTES}-byte inline limit — open the file at the path above.`
              : 'Only image receipts can be returned inline — open the file at the path above.',
          }
        : {}),
    });

    if (inlined && imageMime) {
      result.content.push(...imageResult(base64, imageMime).content);
    }
    return result;
  });
}
