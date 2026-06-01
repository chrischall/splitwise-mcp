import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadDotenvSafely, readEnvVar, formatApiError } from '@chrischall/mcp-utils';

// Load .env for local dev; silently skip if dotenv is unavailable (e.g. mcpb
// bundle). `loadDotenvSafely` swallows a missing dotenv module and never lets
// .env override a host-provided value.
const __dirname = dirname(fileURLToPath(import.meta.url));
await loadDotenvSafely({ path: join(__dirname, '..', '.env'), override: false });

/**
 * Read an env var, trim whitespace, and treat as unset if blank or if the value
 * looks like an unsubstituted shell placeholder (e.g. `${FOO}`) — defends
 * against MCP hosts that pass .mcp.json env blocks through unexpanded.
 *
 * Backed by the shared `readEnvVar` from `@chrischall/mcp-utils`, which applies
 * the same trim + blank/`undefined`/`null`/`${...}`-placeholder suppression.
 */
function readVar(key: string): string | undefined {
  return readEnvVar(key);
}

const BASE_URL = 'https://secure.splitwise.com/api/v3.0';
const SERVICE_NAME = 'Splitwise';

export class SplitwiseClient {
  private readonly apiKey: string | null;
  private readonly configError: Error | null;

  /**
   * Defer the config error so the server can still start (and respond to the
   * host's install-time smoke test) when SPLITWISE_API_KEY isn't set yet.
   * Tool calls re-raise the error at request time.
   */
  constructor() {
    const key = readVar('SPLITWISE_API_KEY');
    if (!key) {
      this.apiKey = null;
      this.configError = new Error('SPLITWISE_API_KEY environment variable is required');
    } else {
      this.apiKey = key;
      this.configError = null;
    }
  }

  private requireKey(): string {
    if (this.configError) throw this.configError;
    return this.apiKey!;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.doRequest<T>(method, path, body, false);
  }

  private async doRequest<T>(
    method: string,
    path: string,
    body: unknown,
    isRetry: boolean
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.requireKey()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status === 401) {
      throw new Error('SPLITWISE_API_KEY is invalid or missing');
    }

    if (response.status === 429) {
      if (!isRetry) {
        await new Promise<void>((r) => setTimeout(r, 2000));
        return this.doRequest<T>(method, path, body, true);
      }
      throw new Error('Rate limited by Splitwise API');
    }

    if (!response.ok) {
      // Surface the upstream error body for debugging. `formatApiError` runs the
      // body through redaction (Bearer tokens / JWTs) THEN truncation, so a body
      // that echoes the request never leaks the API key back to the caller.
      const errorText = await response.text().catch(() => '');
      throw new Error(
        formatApiError(response.status, method, path, errorText, { service: SERVICE_NAME })
      );
    }

    return response.json() as Promise<T>;
  }
}

/**
 * Module-level singleton shared by every tool module. Constructing it here (not
 * in `index.ts`) keeps the deferred-config-error pattern: the server boots and
 * answers the host's install-time tools/list smoke test even when the API key is
 * absent — the error only surfaces on the first request.
 */
export const client = new SplitwiseClient();