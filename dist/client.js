import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
// Load .env for local dev; silently skip if dotenv is unavailable (e.g. mcpb bundle)
try {
    const { config } = await import('dotenv');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    config({ path: join(__dirname, '..', '.env'), override: false });
}
catch {
    // not available — rely on process.env (mcpb sets credentials via mcp_config.env)
}
const BASE_URL = 'https://secure.splitwise.com/api/v3.0';
export class SplitwiseClient {
    apiKey;
    constructor() {
        const key = process.env.SPLITWISE_API_KEY;
        if (!key)
            throw new Error('SPLITWISE_API_KEY environment variable is required');
        this.apiKey = key;
    }
    async request(method, path, body) {
        return this.doRequest(method, path, body, false);
    }
    async doRequest(method, path, body, isRetry) {
        const headers = {
            Authorization: `Bearer ${this.apiKey}`,
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
                await new Promise((r) => setTimeout(r, 2000));
                return this.doRequest(method, path, body, true);
            }
            throw new Error('Rate limited by Splitwise API');
        }
        if (!response.ok) {
            throw new Error(`Splitwise API error: ${response.status} ${response.statusText} for ${method} ${path}`);
        }
        return response.json();
    }
}
