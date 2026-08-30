import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  loadDotenvSafely,
  readEnvVar,
  createApiClient,
  ApiError,
  type ApiClient,
  type RawApiResponse,
} from '@chrischall/mcp-utils';

// Load .env for local dev; silently skip if dotenv is unavailable (e.g. mcpb
// bundle). `loadDotenvSafely` swallows a missing dotenv module and never lets
// .env override a host-provided value.
// The try/catch guards a runtime where `import.meta.url` is undefined and
// `fileURLToPath(undefined)` would throw at module init — a sandboxed one has
// no filesystem or .env to load anyway.
try {
  const dir = dirname(fileURLToPath(import.meta.url));
  await loadDotenvSafely({ path: join(dir, '..', '.env'), override: false });
} catch {
  /* non-Node runtime: no .env to load */
}

const BASE_URL = 'https://secure.splitwise.com/api/v3.0';
const SERVICE_NAME = 'Splitwise';
const SPLITWISE_DOMAIN = 'splitwise.com';

/**
 * Whether a hostname belongs to Splitwise, and may therefore be sent the API
 * key. Receipt bytes are served either from a Splitwise host (which requires
 * the key) or from a presigned third-party URL (S3), which must never see it.
 */
export function isSplitwiseHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === SPLITWISE_DOMAIN || host.endsWith(`.${SPLITWISE_DOMAIN}`);
}

/** Parse an asset URL handed back by the API, rejecting anything not https. */
function parseAssetUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Deliberately not echoing the URL: it can carry a signed token.
    throw new Error('Splitwise returned an asset URL that could not be parsed');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing to fetch an asset over ${parsed.protocol}// — https only`);
  }
  return parsed;
}

/**
 * Strip the asset URL's signed query string out of an error message. A failed
 * `fetchRaw` names the path it requested, and a receipt URL's query carries a
 * signed, capability-bearing token that must not reach a tool result.
 *
 * Matches the exact query bytes we sent rather than a pattern for the message
 * shape: that keeps working whatever an upstream formatter does with the URL
 * (relative path today, absolute URL tomorrow), and it can't mangle an error
 * body that happens to contain a `?`.
 */
function redactAssetQuery(err: unknown, search: string): unknown {
  if (!(err instanceof Error) || !search) return err;
  const message = err.message.split(search).join('?<redacted>');
  if (message === err.message) return err;
  return err instanceof ApiError ? new ApiError(err.status, message) : new Error(message);
}

export class SplitwiseClient {
  private readonly apiKey: string | null;
  /** Which source supplied the API key — a LABEL, never the value. */
  private readonly credentialSource: 'injected' | 'env' | null;
  private readonly configError: Error | null;
  private readonly api: ApiClient;
  /** Per-origin clients for asset hosts, built on first use by `fetchAsset`. */
  private readonly assetClients = new Map<string, ApiClient>();

  /**
   * Defer the config error so the server can still start (and respond to the
   * host's install-time smoke test) when SPLITWISE_API_KEY isn't set yet.
   * Tool calls re-raise the error at request time.
   *
   * Optional constructor seam: a hosted per-user deployment builds one client
   * per request with that user's `apiKey` injected. The stdio path passes no
   * options, so the key resolves from the environment exactly as before —
   * byte-for-byte identical behaviour.
   */
  constructor(opts?: { apiKey?: string }) {
    // Injected apiKey (hosted per-user path) takes precedence; otherwise fall
    // back to the env var. readEnvVar trims whitespace and treats
    // blank/`undefined`/`null`/`${...}` placeholder values as unset — defends
    // against MCP hosts that pass .mcp.json env blocks through unexpanded.
    const injected = opts?.apiKey;
    const key = injected ?? readEnvVar('SPLITWISE_API_KEY');
    // Which source supplied it, for `sw_healthcheck`. Derived from the SAME
    // `key` and `injected` bindings the resolution above uses, so the two
    // cannot disagree. An earlier version re-tested `opts?.apiKey` for
    // TRUTHINESS while the resolution used `??`: an injected empty string is
    // not nullish, so `key` became `''` and the client reported a config error
    // while the source said `env` — the healthcheck naming a source the client
    // had not used.
    this.credentialSource = !key ? null : injected !== undefined ? 'injected' : 'env';
    if (!key) {
      this.apiKey = null;
      this.configError = new Error('SPLITWISE_API_KEY environment variable is required');
    } else {
      this.apiKey = key;
      this.configError = null;
    }

    this.api = this.buildApiClient(BASE_URL, true);
  }

  /**
   * Which source supplied the API key, for `sw_healthcheck`. Returns a LABEL
   * or `null` — deliberately never the key, since the healthcheck result is
   * the thing people paste into a chat when something is broken.
   */
  describeCredential(): { source: string | null } {
    return { source: this.credentialSource };
  }

  /**
   * One API client per origin, sharing the fleet's retry/timeout/error policy.
   * `authenticated` decides whether the API key is attached: `getToken` defers
   * config errors to request time, and on* handlers preserve Splitwise's
   * documented 401/429 messages.
   */
  private buildApiClient(baseUrl: string, authenticated: boolean): ApiClient {
    // An anonymous asset origin isn't Splitwise, so name it accurately in
    // errors rather than blaming the Splitwise API for a third party's 429.
    const service = authenticated ? SERVICE_NAME : new URL(baseUrl).host;
    return createApiClient({
      baseUrl,
      serviceName: service,
      retry: { count: 1, delayMs: 2000 },
      timeout: 30_000,
      ...(authenticated ? { getToken: () => this.requireKey() } : {}),
      onUnauthorized: () =>
        new Error(
          authenticated
            ? 'SPLITWISE_API_KEY is invalid or missing'
            : 'The asset URL was rejected (401) — presigned URLs are short-lived, so re-run to get a fresh one',
        ),
      onRateLimited: () => new Error(`Rate limited by ${authenticated ? 'Splitwise API' : service}`),
    });
  }

  private requireKey(): string {
    if (this.configError) throw this.configError;
    return this.apiKey!;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.api.fetchJson<T>(method, path, body !== undefined ? { body } : {});
  }

  /**
   * Fetch the raw bytes behind an absolute asset URL the API handed back (an
   * expense receipt). Splitwise serves receipts two ways and this covers both:
   * from its own API (`https://www.splitwise.com/api/v4.0/expenses/{id}/receipt`),
   * which 401s without the key, and from a presigned S3 URL, which carries its
   * own signature and must NOT be sent the key. `isSplitwiseHost` picks.
   *
   * A cross-origin redirect (API → S3) is safe: per the Fetch standard the
   * `Authorization` header is dropped when a redirect changes origin.
   */
  async fetchAsset(url: string): Promise<RawApiResponse> {
    const target = parseAssetUrl(url);
    const authenticated = isSplitwiseHost(target.hostname);
    const cacheKey = `${target.origin}|${authenticated ? 'auth' : 'anon'}`;

    let api = this.assetClients.get(cacheKey);
    if (!api) {
      api = this.buildApiClient(target.origin, authenticated);
      this.assetClients.set(cacheKey, api);
    }

    try {
      // `pathname + search` verbatim rather than the client's `query` option:
      // a presigned signature covers the exact encoding, so re-encoding it
      // would invalidate the URL.
      return await api.fetchRaw('GET', `${target.pathname}${target.search}`);
    } catch (err) {
      throw redactAssetQuery(err, target.search);
    }
  }
}

/**
 * Module-level singleton shared by every tool module. Constructing it here (not
 * in `index.ts`) keeps the deferred-config-error pattern: the server boots and
 * answers the host's install-time tools/list smoke test even when the API key is
 * absent — the error only surfaces on the first request.
 */
export const client = new SplitwiseClient();
