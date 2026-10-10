import { createHash } from 'crypto';
import { z } from 'zod';

/**
 * Splitwise does not document an upload cap. This bound matches the receipt
 * download cap, so anything this server accepts it can also read back.
 */
export const MAX_RECEIPT_BYTES = 25 * 1024 * 1024;

/** The types the Splitwise web UI offers ("Attach an image or PDF"). */
const RECEIPT_TYPES = [
  { mime: 'image/png', ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', ext: 'gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
] as const;

export const receiptParam = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        'Absolute path to an image or PDF on the machine running this server. Not usable from a hosted deployment — use base64 there.',
      )
      .optional(),
    base64: z
      .string()
      .min(1)
      .describe('The file bytes, base64-encoded (a data: URL prefix is accepted and stripped).')
      .optional(),
    filename: z
      .string()
      .min(1)
      .max(200)
      .describe('Name to store the file under. Defaults to the path basename, or receipt.<ext>.')
      .optional(),
  })
  .describe(
    'Receipt to attach: PNG, JPEG, GIF or PDF, up to 25 MiB. Give exactly one of path or base64. The type is detected from the file contents. Replaces any receipt already on the expense.',
  )
  .optional();

export type ReceiptInput = z.infer<typeof receiptParam>;

export interface LoadedReceipt {
  bytes: Uint8Array<ArrayBuffer>;
  filename: string;
  mimeType: string;
  /** What the confirmation preview shows instead of the bytes. */
  summary: { filename: string; mime_type: string; bytes: number; sha256: string };
}

function sniff(bytes: Uint8Array): (typeof RECEIPT_TYPES)[number] | undefined {
  return RECEIPT_TYPES.find((t) => t.magic.every((b, i) => bytes[i] === b));
}

function decodeBase64(input: string): Uint8Array<ArrayBuffer> {
  const stripped = input.replace(/^data:[^;,]*;base64,/i, '').replace(/\s+/g, '');
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
 * Read and validate a receipt before the confirmation gate, so a bad file is
 * refused on the first call and the preview can name exactly what will be sent.
 */
export async function loadReceipt(input: NonNullable<ReceiptInput>): Promise<LoadedReceipt> {
  const hasPath = input.path !== undefined;
  const hasBase64 = input.base64 !== undefined;
  if (hasPath === hasBase64) {
    throw new Error('receipt needs exactly one of path or base64');
  }

  let bytes: Uint8Array<ArrayBuffer>;
  if (hasPath) {
    // Lazy import: a hosted deployment that only ever sends base64 never
    // touches the filesystem module.
    const { readFile, stat } = await import('fs/promises');
    let size: number;
    try {
      const info = await stat(input.path!);
      if (!info.isFile()) throw new Error('not a regular file');
      size = info.size;
    } catch (err) {
      throw new Error(`Cannot read receipt file ${input.path}: ${(err as Error).message}`);
    }
    if (size > MAX_RECEIPT_BYTES) {
      throw new Error(`Receipt file is ${size} bytes; the limit is ${MAX_RECEIPT_BYTES}`);
    }
    bytes = Uint8Array.from(await readFile(input.path!));
  } else {
    bytes = decodeBase64(input.base64!);
  }

  if (bytes.length === 0) throw new Error('Receipt file is empty');
  if (bytes.length > MAX_RECEIPT_BYTES) {
    throw new Error(`Receipt is ${bytes.length} bytes; the limit is ${MAX_RECEIPT_BYTES}`);
  }

  const type = sniff(bytes);
  if (!type) {
    throw new Error('Receipt must be a PNG, JPEG, GIF or PDF (detected from the file contents)');
  }

  let filename = cleanFilename(input.filename ?? (hasPath ? input.path! : ''));
  if (!filename) filename = `receipt.${type.ext}`;

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
 * every expense field as a form field, plus the file under `receipt`.
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
