# Deploying the Splitwise remote connector

This is the operator runbook for standing up `splitwise-mcp` as a hosted
Cloudflare Worker — a "remote connector" that anyone you share the URL with can
add to claude.ai (web, desktop, or mobile), each logging in with their own
Splitwise API key. Standing it up is a manual, one-time (per operator) process:
none of the steps below can be done by an agent, since they require your own
Cloudflare account. Once it's standing, though, deploys are automated — the
`deploy-connector` job in `.github/workflows/release-please.yml` redeploys the
Worker on every release, pinned to the release tag, and
`.github/workflows/deploy-connector.yml` gives an on-demand
**Actions → deploy-connector → Run workflow** path for any ref.

If you just want the server on your own machine talking only to your own
Splitwise account, you don't need any of this — see the main
[README](../README.md) for the local stdio / `.mcpb` install instead, which is
the desktop-only alternative to running a shared connector.

## Prerequisites

- A Cloudflare account (free tier is fine).
- Node and this repo checked out with dependencies installed (`npm install`).
- **No app-level Splitwise API keys are required.** Unlike some connectors,
  Splitwise has no operator-shared `client_id` / `client_secret`. Each user
  authenticates with their own Splitwise API key (from
  <https://secure.splitwise.com/apps/register>), collected by the connector's
  own OAuth login page (step 4) — you never handle anyone's Splitwise key.

## Steps

### 1. Log in to Cloudflare

```sh
npx wrangler login
```

This opens a browser to authorize the CLI against your Cloudflare account.

### 2. Create the OAuth KV namespace

The connector stores OAuth state and per-user session data (including each
user's encrypted Splitwise API key) in a KV namespace bound as `OAUTH_KV` (see
`wrangler.jsonc`).

```sh
npx wrangler kv namespace create OAUTH_KV
```

The command prints something like:

```
{ "binding": "OAUTH_KV", "id": "abcd1234..." }
```

Copy the returned `id` into `wrangler.jsonc`, replacing the
`"REPLACE_WITH_OAUTH_KV_NAMESPACE_ID"` placeholder:

```jsonc
"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "abcd1234..." }],
```

### 3. Deploy

```sh
npm run worker:deploy
```

This runs `wrangler deploy`, which builds and pushes `src/worker.ts` (plus the
`SplitwiseMcpAgent` per-session agent Durable Object binding, and the `OAUTH_KV`
namespace from step 2). On success it prints the deployed URL:

```
https://splitwise-connector.<your-subdomain>.workers.dev
```

Because `wrangler.jsonc` also declares a custom-domain route
(`connector.splitwise.nullnet.app`, matching ofw-mcp's
`connector.ofw.nullnet.app` and untappd-mcp's `connector.untappd.nullnet.app`),
the connector is additionally served at:

```
https://connector.splitwise.nullnet.app
```

Use the custom domain as the stable production URL you share. (The zone must be
in the deploying Cloudflare account; if it isn't, remove the `routes` entry from
`wrangler.jsonc` and use the `*.workers.dev` URL instead.) Note whichever URL you
use — it's what gets added as a connector, with `/mcp` appended.

You only need to run this deploy by hand once, to get the Worker created under
your account. From then on CI redeploys it on release (and on demand from the
Actions tab); `npm run worker:deploy` stays available for pushing an unreleased
working tree from your own machine.

> **Stateless — no cache Durable Object.** Splitwise reads always hit the live
> API, so unlike the OFW connector there is no per-user message cache: the only
> Durable Object is `SplitwiseMcpAgent` (the per-session MCP agent), declared in
> `wrangler.jsonc` with a `v1` SQLite migration applied automatically by
> `wrangler deploy`.

Before deploying to production, you can sanity-check the Worker locally with:

```sh
npm run worker:dev
```

confirm it bundles without deploying:

```sh
npx wrangler deploy --dry-run
```

and run the Worker-specific test suite (Miniflare / real Workers runtime) with:

```sh
npm run worker:test
```

### 4. Add it as a connector in claude.ai

1. Go to claude.ai → **Settings** → **Connectors** → **Add custom connector**.
2. Paste the deployed URL with `/mcp` appended — the custom domain
   `https://connector.splitwise.nullnet.app/mcp` (or, without a custom domain,
   `https://splitwise-connector.<your-subdomain>.workers.dev/mcp`).
3. Claude will open the connector's login page (served by the Worker at
   `/authorize`) and prompt for a **Splitwise API key**. The key is verified
   against Splitwise's current-user endpoint before the session is created — an
   invalid key is rejected on the login page.

This connector is unlisted: it only shows up for people you've explicitly shared
the URL with, not in any public directory. Anyone with the URL who supplies
their own valid Splitwise API key can use it under their own account.

### 5. Verify on the mobile Claude app

Connectors added on claude.ai sync to all clients for that account, including
the **mobile Claude app**. On mobile:

1. Confirm the connector appears (Settings → Connectors) and shows as connected.
2. Run a read, e.g. ask Claude to run `sw_get_current_user` or
   `sw_list_expenses`.
3. Run a low-stakes write to confirm the write tools are wired up. Every
   mutating tool is **confirm-gated**: the first call returns a dry-run preview
   of exactly what would be sent, and only a follow-up call with `confirm: true`
   executes it.

If both work, the deploy is verified end-to-end.

## Full-write, confirm-gated

Unlike the OFW connector's structural `OFW_WRITE_MODE` gate, this connector
registers **all 25 tools**, including every write (create/update/delete of
expenses, groups, friends, comments, and the user profile). Safety comes from
each mutating tool's per-call confirmation (`src/tools/_confirm.ts`): a write is
previewed as a no-network dry run unless the caller passes `confirm: true`, so a
single hallucinated tool call can't silently notify other people or mutate
shared data.

## How auth works

- There are **no operator-level Splitwise credentials.** Splitwise has no shared
  app `client_id` / `client_secret`; the connector authenticates each user
  individually.
- Each **user** who adds the connector logs in with their *own* Splitwise API
  key, via the login page the Worker serves at `/authorize`. The key is verified
  (`GET /get_current_user`) before the session is created.
- That key is stored **encrypted at rest** in the OAuth provider's KV-backed
  "props" (`OAUTH_KV`), scoped to that user's session. Splitwise keys are
  long-lived with no refresh cycle, so — unlike the OFW connector, which stores a
  password to re-run a short-lived token login — the stored key is used directly
  to build a per-user `SplitwiseClient` on each request. It is used only to call
  Splitwise on that user's behalf, never for anything else.

## Rotation / teardown

There are no operator secrets to rotate for Splitwise auth (users manage their
own Splitwise API keys; a user rotates by re-adding the connector with a new
key).

Tear down the whole connector:

```sh
npx wrangler kv namespace delete --namespace-id <id-from-step-2>
```

then delete the Worker itself from the Cloudflare dashboard (Workers &
Pages → `splitwise-connector` → Settings → Delete), or via:

```sh
npx wrangler delete
```

Deleting the KV namespace invalidates every stored user session — everyone who
had added the connector will need to log in again with their key if it's
redeployed.
