import { createHash } from 'crypto';
import { ApiError, readEnvVar } from '@chrischall/mcp-utils';
import type { SplitwiseClient } from '../client.js';
import { blobConfig, signedGetUrl, UPLOAD_ID_PATTERN } from './_blob.js';
import { z } from 'zod';

/**
 * Splitwise does not document an upload cap, so this is a conservative 10 MiB:
 * comfortably above a phone photo or a multi-page PDF receipt, and small
 * enough that the base64 form (≈13.4 MiB) stays a reasonable tool argument.
 */
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const LIMIT_LABEL = '10 MiB';

/** The types the Splitwise web UI offers ("Attach an image or PDF"). */
const RECEIPT_TYPES = [
  { mime: 'image/png', ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', ext: 'gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
] as const;

/** Spellings a caller may reasonably send for a detected type. */
const MIME_ALIASES: Record<string, string> = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg' };

export const receiptSchema = z
  .object({
    base64: z
      .string()
      .min(1)
      .describe('The file bytes, base64-encoded (a data: URL prefix is accepted and stripped). Costs context for every byte — on the hosted server prefer upload_id.')
      .optional(),
    path: z
      .string()
      .min(1)
      .describe(
        'A file inside SPLITWISE_INPUT_DIR on the machine running this server (relative to it, or absolute). Only works when that variable is set — never on a hosted server; use upload_id (or base64) there.',
      )
      .optional(),
    upload_id: z
      .string()
      .min(1)
      .describe('The upload_id from sw_get_upload_url, after the file was PUT to its upload_url. The way to send a full-size file to the hosted server without base64.')
      .optional(),
    filename: z.string().min(1).max(200).describe('Name to store the file under, e.g. "receipt.pdf".'),
    mime_type: z
      .string()
      .describe('Optional. If given, it must match the type detected from the file contents.')
      .optional(),
  })
  .describe(
    `Receipt to attach: PNG, JPEG, GIF or PDF, up to ${LIMIT_LABEL}. Give exactly one of upload_id, path or base64. The type is detected from the file contents. Replaces any receipt already on the expense.`,
  );

export const receiptParam = receiptSchema.optional();

export type ReceiptInput = z.infer<typeof receiptSchema>;

export interface LoadedReceipt {
  bytes: Uint8Array<ArrayBuffer>;
  filename: string;
  mimeType: string;
  /** What the confirmation preview shows instead of the bytes. */
  summary: { filename: string; mime_type: string; bytes: number; sha256: string };
}

const tooBig = (size: number) =>
  new Error(`Receipt is ${size} bytes, over the ${LIMIT_LABEL} limit (${MAX_RECEIPT_BYTES} bytes)`);

function sniff(bytes: Uint8Array): (typeof RECEIPT_TYPES)[number] | undefined {
  return RECEIPT_TYPES.find((t) => t.magic.every((b, i) => bytes[i] === b));
}

function decodeBase64(input: string): Uint8Array<ArrayBuffer> {
  const stripped = input.replace(/^data:[^;,]*;base64,/i, '').replace(/\s+/g, '');
  // Refuse on the encoded length so an oversized argument is never decoded.
  const decodedSize = Math.floor((stripped.length * 3) / 4) - (stripped.match(/=*$/)?.[0].length ?? 0);
  if (decodedSize > MAX_RECEIPT_BYTES) throw tooBig(decodedSize);
  // Never echo the input: it is the caller's file.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped) || stripped.length % 4 === 1) {
    throw new Error('receipt.base64 is not valid base64');
  }
  return Uint8Array.from(Buffer.from(stripped, 'base64'));
}

/** Keep the stored name to a plain basename: no directories, no control characters. */
function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
}

/**
 * Read a receipt from SPLITWISE_INPUT_DIR. Unset means no filesystem access at
 * all — the hosted case, where the caller's files are not on this machine and
 * the server's own files must not be reachable. Both the dir and the target
 * are realpath-resolved, so `..` and symlinks (to a file or through a
 * directory) that lead out of the dir are refused; the bytes are then read
 * through the handle that was checked, not by re-opening the name.
 */
async function readSandboxed(requested: string): Promise<Uint8Array<ArrayBuffer>> {
  const dir = readEnvVar('SPLITWISE_INPUT_DIR');
  if (!dir) {
    throw new Error(
      'receipt.path is disabled: SPLITWISE_INPUT_DIR is not set on this server (and a hosted server cannot see your files). Pass the file as receipt.base64 instead.',
    );
  }
  const { open, realpath } = await import('fs/promises');
  const { constants } = await import('fs');
  const { isAbsolute, relative, resolve, sep } = await import('path');

  let root: string;
  try {
    root = await realpath(dir);
  } catch (err) {
    throw new Error(`SPLITWISE_INPUT_DIR (${dir}) is not readable: ${(err as Error).message}`);
  }
  let target: string;
  try {
    target = await realpath(resolve(root, requested));
  } catch (err) {
    throw new Error(`Cannot read receipt file ${requested}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  const rel = relative(root, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`receipt.path ${requested} resolves outside SPLITWISE_INPUT_DIR`);
  }

  // O_NOFOLLOW: a symlink swapped in after the realpath check is refused.
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Cannot read receipt file ${requested}: not a regular file`);
    if (info.size > MAX_RECEIPT_BYTES) throw tooBig(info.size);
    return Uint8Array.from(await handle.readFile());
  } finally {
    await handle.close();
  }
}

/** How long the server's own read link for an upload lives — it is used at once. */
const UPLOAD_READ_TTL_MS = 5 * 60 * 1000;

/**
 * Read a file the caller PUT to a `sw_get_upload_url` link, through a signed
 * GET on the same blob store. Only `up/<uuid>/<name>` keys are accepted.
 */
async function readUpload(uploadId: string, client: SplitwiseClient | undefined): Promise<Uint8Array<ArrayBuffer>> {
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    throw new Error('receipt.upload_id is not one sw_get_upload_url issued (expected up/<uuid>/<filename>)');
  }
  const cfg = blobConfig();
  if (!cfg || !client) {
    throw new Error('receipt.upload_id only works on the hosted server; pass receipt.path or receipt.base64 here.');
  }
  try {
    const asset = await client.fetchAsset(signedGetUrl(cfg, uploadId, Date.now() + UPLOAD_READ_TTL_MS), {
      maxBytes: MAX_RECEIPT_BYTES,
    });
    return Uint8Array.from(asset.bytes);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
      throw new Error(
        `No upload found for receipt.upload_id ${uploadId} — the PUT may not have run, failed, or the upload expired. Get a fresh link with sw_get_upload_url and upload the file again.`,
      );
    }
    if ((err as { kind?: string }).kind === 'too_large') {
      throw new Error(`The uploaded receipt is over the ${LIMIT_LABEL} limit (${MAX_RECEIPT_BYTES} bytes)`);
    }
    throw err;
  }
}

/** The canonical MIME type for an upload, or an error naming the ones Splitwise takes. */
export function canonicalReceiptMime(contentType: string): string {
  const claimed = contentType.trim().toLowerCase();
  const mime = MIME_ALIASES[claimed] ?? claimed;
  if (!RECEIPT_TYPES.some((t) => t.mime === mime)) {
    throw new Error(`content_type must be one of ${RECEIPT_TYPES.map((t) => t.mime).join(', ')} (got ${contentType})`);
  }
  return mime;
}

/**
 * Read and validate a receipt before the confirmation gate, so a bad file is
 * refused on the first call and the preview can name exactly what will be sent.
 */
export async function loadReceipt(input: ReceiptInput, client?: SplitwiseClient): Promise<LoadedReceipt> {
  const sources = [input.upload_id, input.path, input.base64].filter((v) => v !== undefined).length;
  if (sources !== 1) {
    throw new Error('receipt needs exactly one of upload_id, path or base64');
  }

  const bytes =
    input.upload_id !== undefined
      ? await readUpload(input.upload_id, client)
      : input.path !== undefined
        ? await readSandboxed(input.path)
        : decodeBase64(input.base64!);
  if (bytes.length === 0) throw new Error('Receipt file is empty');
  if (bytes.length > MAX_RECEIPT_BYTES) throw tooBig(bytes.length);

  const type = sniff(bytes);
  if (!type) {
    throw new Error('Receipt must be a PNG, JPEG, GIF or PDF (detected from the file contents)');
  }
  if (input.mime_type !== undefined) {
    const claimed = input.mime_type.trim().toLowerCase();
    if ((MIME_ALIASES[claimed] ?? claimed) !== type.mime) {
      throw new Error(`receipt.mime_type ${claimed} does not match the file contents (${type.mime})`);
    }
  }

  const filename = cleanFilename(input.filename) || `receipt.${type.ext}`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    bytes,
    filename,
    mimeType: type.mime,
    summary: { filename, mime_type: type.mime, bytes: bytes.length, sha256 },
  };
}

/**
 * Build the multipart body Splitwise takes when an expense carries a file:
 * every expense field as a form field (the same flat `users__N__*` keys the
 * JSON path sends), plus the file under `receipt`.
 */
export function buildReceiptForm(fields: Record<string, unknown>, receipt: LoadedReceipt): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    form.append(key, String(value));
  }
  form.append('receipt', new Blob([receipt.bytes], { type: receipt.mimeType }), receipt.filename);
  return form;
}

/**
 * After a receipt write, confirm Splitwise actually stored the file. It can
 * answer 200 with the expense saved and `receipt.original` still null; that is
 * a failure the caller must hear about, not a success. Returns the response
 * with `receipt_attached` and the expense's `receipt` lifted to the top.
 */
export function verifyReceiptStored(data: unknown, expenseId: number | undefined): Record<string, unknown> {
  const expense = (data as { expenses?: Array<{ id?: number; receipt?: { original?: unknown } }> } | null)
    ?.expenses?.[0];
  const id = expense?.id ?? expenseId;
  if (!expense?.receipt?.original) {
    throw new Error(
      `Splitwise saved expense ${id ?? '(unknown id)'} but did not attach the receipt (receipt.original is empty). ` +
        `The expense itself was written — do not re-create it; retry the file with sw_attach_receipt on expense ${id ?? '<id>'}.`,
    );
  }
  return { receipt_attached: true, receipt: expense.receipt, ...(data as object) };
}
