import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadDotenvSafely, readEnvVar, createApiClient, type ApiClient } from '@chrischall/mcp-utils';

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
  private readonly api: ApiClient;

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

    // `getToken` defers config errors to request time; on* handlers preserve Splitwise's documented 401/429 messages.
    this.api = createApiClient({
      baseUrl: BASE_URL,
      getToken: () => this.requireKey(),
      serviceName: SERVICE_NAME,
      retry: { count: 1, delayMs: 2000 },
      onUnauthorized: () => new Error('SPLITWISE_API_KEY is invalid or missing'),
      onRateLimited: () => new Error('Rate limited by Splitwise API'),
    });
  }

  private requireKey(): string {
    if (this.configError) throw this.configError;
    return this.apiKey!;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.api.fetchJson<T>(method, path, body !== undefined ? { body } : {});
  }
}

/**
 * Module-level singleton shared by every tool module. Constructing it here (not
 * in `index.ts`) keeps the deferred-config-error pattern: the server boots and
 * answers the host's install-time tools/list smoke test even when the API key is
 * absent — the error only surfaces on the first request.
 */
export const client = new SplitwiseClient();