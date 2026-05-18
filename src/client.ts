import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Load .env for local dev; silently skip if dotenv is unavailable (e.g. mcpb bundle)
try {
  const { config } = await import('dotenv');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  config({ path: join(__dirname, '..', '.env'), override: false, quiet: true });
} catch {
  // not available — rely on process.env (mcpb sets credentials via mcp_config.env)
}

/**
 * Read an env var, trim whitespace, and treat as unset if blank or if the value
 * looks like an unsubstituted shell placeholder (e.g. `${FOO}`) — defends
 * against MCP hosts that pass .mcp.json env blocks through unexpanded.
 */
function readVar(key: string): string | undefined {
  const raw = process.env[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === 'undefined' || trimmed === 'null') return undefined;
  if (/^\$\{[^}]*\}$/.test(trimmed)) return undefined;
  return trimmed;
}

const BASE_URL = 'https://secure.splitwise.com/api/v3.0';

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
      throw new Error(
        `Splitwise API error: ${response.status} ${response.statusText} for ${method} ${path}`
      );
    }

    return response.json() as Promise<T>;
  }
}