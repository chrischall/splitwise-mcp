import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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

/** Cap on bytes returned as base64 in the tool result. */
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

/** Cap on extracted characters, so a long PDF can't flood the result. */
const MAX_TEXT_CHARS = 100_000;

const PDF_MIME = 'application/pdf';

/** Content types that carry no information about the actual format. */
const GENERIC_TYPES = new Set(['application/octet-stream', 'binary/octet-stream']);

/** `%PDF-` magic bytes — `sniffMimeBytes` only knows the image formats. */
function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';
}

/**
 * Best-effort MIME type for the downloaded bytes.
 *
 * The magic bytes win over the declared Content-Type: the header is a hint an
 * object store often gets wrong (`application/force-download`, `application/
 * x-pdf`, `application/octet-stream`), while the signature describes what the
 * bytes actually are. Sniffing only recognises the handful of formats a
 * receipt arrives in, so anything it can't place falls back to what the server
 * claimed — and a claim of nothing-in-particular falls back to undefined.
 *
 * Everything downstream reads this one value, so getting it right here is what
 * keeps the file extension, the inline block's type, and the text-extraction
 * gate agreeing with each other.
 */
function resolveMimeType(contentType: string | null, bytes: Uint8Array): string | undefined {
  const sniffed = sniffMimeBytes(bytes) ?? (isPdf(bytes) ? PDF_MIME : undefined);
  if (sniffed) return sniffed;
  const declared = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return declared && !GENERIC_TYPES.has(declared) ? declared : undefined;
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

/**
 * Extract a PDF's text layer. `unpdf` is imported lazily so the cost lands only
 * on calls that ask for text — it is a sizable pdf.js build, and every other
 * receipt path (download, inline, write) must not pay for it at startup.
 *
 * Returns `''` for a PDF with no text layer, which is the normal case for a
 * photographed or scanned receipt.
 */
async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  // Copy: pdf.js transfers/detaches the buffer it is handed, and the caller
  // still needs these bytes for the base64 and the file write.
  const doc = await getDocumentProxy(Uint8Array.from(bytes));
  const { text } = await extractText(doc, { mergePages: true });
  return (Array.isArray(text) ? text.join('\n') : text).trim();
}

/** An MCP embedded-resource block — how non-image bytes ride back in a result. */
function resourceBlock(uri: string, mimeType: string, base64: string): CallToolResult['content'][number] {
  return { type: 'resource', resource: { uri, mimeType, blob: base64 } };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerReceiptTools(server: McpServer, client: SplitwiseClient): void {
  server.registerTool('sw_get_receipt', {
    description:
      "Download the receipt image or PDF attached to a Splitwise expense. The receipt URLs returned by sw_get_expense need the server's credentials — fetching them directly returns 401 — so use this tool instead. Set inline:true to get the bytes back in the result (images AND PDFs), or extract_text:true to get a PDF's text without the binary at all — both work when the caller can't see this server's filesystem. It also writes the file and returns the path, unless write:false or the filesystem is read-only.",
    // Not read-only: this writes a file into a caller-supplied directory, and
    // `readOnlyHint` is what a host reads when deciding to skip its approval
    // prompt. Not destructive either — `uniquePath` always picks a filename
    // that doesn't exist, so an existing file is never touched.
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      id: z.number().describe('Expense ID (the same id sw_get_expense takes)'),
      size: z
        .enum(['original', 'large'])
        .describe("Which stored rendition to fetch. Defaults to 'original' (full quality, and the only one a PDF receipt has). Falls back to the other rendition when the requested one is absent.")
        .optional(),
      inline: z
        .boolean()
        .describe(`Return the receipt bytes in the result — an image block for images, an embedded resource for PDFs and everything else. Only for receipts under ${MAX_INLINE_BYTES} bytes.`)
        .optional(),
      extract_text: z
        .boolean()
        .describe("Also return the PDF's text layer as `text`. Ideal for looking up line items or totals without transferring the file. PDFs only; a scanned receipt has no text layer to extract.")
        .optional(),
      output_dir: z
        .string()
        .describe('Directory to write the receipt into. Defaults to $SPLITWISE_OUTPUT_DIR, else the current working directory.')
        .optional(),
      write: z
        .boolean()
        .describe('Write the receipt to disk. Defaults to true. Pass false when the caller cannot reach this server\'s filesystem, or when the server runs read-only.')
        .optional(),
    },
  }, async ({ id, size, inline, extract_text, output_dir, write }) => {
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

    // The write is best-effort: a hosted server often runs on a read-only
    // filesystem, and failing the whole call there would strand a caller who
    // only wanted the content. Report it and carry on — unless nothing else
    // was requested, in which case there is no result to return (below).
    let path: string | undefined;
    let writeError: string | undefined;
    if (write !== false) {
      try {
        path = writeBinaryOutput({
          dir: resolveOutputDir(output_dir, 'SPLITWISE_OUTPUT_DIR'),
          baseName: `splitwise-receipt-${id}`,
          base64,
          extension: extensionFor(mimeType, url),
        });
      } catch (err) {
        writeError = describeError(err);
      }
    }

    const oversized = asset.bytes.length > MAX_INLINE_BYTES;
    const inlined = inline === true && !oversized;

    let text: string | undefined;
    let textNote: string | undefined;
    if (extract_text === true) {
      if (mimeType !== PDF_MIME) {
        textNote = `Text extraction covers PDFs only; this receipt is ${mimeType ?? 'of an unknown type'}. Use inline:true to get the bytes.`;
      } else {
        try {
          const extracted = await extractPdfText(asset.bytes);
          if (extracted.length === 0) {
            textNote = 'This PDF has no text layer — it is probably a scan or photo. Use inline:true to read the receipt itself.';
          } else if (extracted.length > MAX_TEXT_CHARS) {
            text = extracted.slice(0, MAX_TEXT_CHARS);
            textNote = `Text truncated to the first ${MAX_TEXT_CHARS} characters.`;
          } else {
            text = extracted;
          }
        } catch (err) {
          textNote = `Could not extract text: ${describeError(err)}. Use inline:true to get the bytes.`;
        }
      }
    }

    // Nothing reached the caller: no file, no bytes, no text. Fail loudly and
    // name the way out rather than reporting a success with an empty result.
    if (path === undefined && !inlined && text === undefined) {
      const reason = writeError
        ? `could not be written (${writeError})`
        : 'was not written (write:false)';
      // Say why the content the caller actually asked for is missing. Advising
      // `inline:true` to someone who just passed it — because the PDF turned
      // out to be a scan, or the file was over the cap — is worse than useless.
      const detail = textNote
        ? ` ${textNote}`
        : inline === true && oversized
          ? ` The receipt is ${asset.bytes.length} bytes, over the ${MAX_INLINE_BYTES}-byte inline limit, so it can only be read from disk — point output_dir somewhere writable.`
          : ' Re-run with inline:true for the bytes, or extract_text:true for a PDF\'s text.';
      throw new Error(
        `The receipt for expense ${id} ${reason}, and nothing was returned in its place.${detail}`,
      );
    }

    const result = textResult({
      expense_id: id,
      size: served,
      ...(served !== wanted
        ? { requested_size: wanted, note: `Expense ${id} has no ${wanted} rendition; fetched ${served}.` }
        : {}),
      ...(path !== undefined ? { path } : {}),
      ...(writeError !== undefined ? { write_error: writeError } : {}),
      bytes: asset.bytes.length,
      content_type: mimeType ?? 'unknown',
      // The receipt URL itself is a signed capability, so report only its host.
      source_host: new URL(url).host,
      inline: inlined,
      ...(inline === true && oversized
        ? {
            // The write outcome is already known, so don't advise `write:true`
            // to someone who either has the file or just watched the write fail.
            inline_skipped:
              `Receipt is ${asset.bytes.length} bytes, over the ${MAX_INLINE_BYTES}-byte inline limit — ` +
              (path !== undefined
                ? 'read it from the path above.'
                : 'get it on disk instead, with write:true and an output_dir this server can write to.'),
          }
        : {}),
      ...(text !== undefined ? { text } : {}),
      ...(textNote !== undefined ? { text_note: textNote } : {}),
    });

    if (inlined) {
      const type = mimeType ?? 'application/octet-stream';
      result.content.push(
        type.startsWith('image/')
          ? imageResult(base64, type).content[0]!
          : resourceBlock(`splitwise://expenses/${id}/receipt`, type, base64),
      );
    }
    return result;
  });
}
