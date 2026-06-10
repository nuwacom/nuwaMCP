# UiPath Orchestrator MCP Server — Vercel Edition

An [MCP](https://modelcontextprotocol.io) server that exposes **UiPath Orchestrator** as tools a **nuwacom agent** can call — start/stop jobs, check status, manage queues, discover folders/processes/queues. This edition runs on **Vercel** as a Next.js app using the [`mcp-handler`](https://www.npmjs.com/package/mcp-handler) adapter.

```
nuwacom agent  ──►  https://<your-app>.vercel.app/api/mcp  ──►  UiPath Orchestrator
   (LLM+tools)        (this server, on Vercel)                   (cloud or self-hosted)
```

Works against **UiPath Automation Cloud** and **self-hosted / Automation Suite** — controlled by environment variables.

---

## What's different from the container edition

This is the same tool logic ported to Vercel's serverless model:

- The Express server is replaced by a single MCP route at `app/api/[transport]/route.ts` (served at `/api/mcp`).
- The OAuth token is cached in a module variable that's reused on warm function instances; on a cold start it re-fetches (cheap, correct). No Redis required because Orchestrator calls return quickly and tokens last ~1 hour.
- Auth is a shared bearer token (`MCP_AUTH_TOKEN`) checked on every request.

> **Serverless timeout note:** Vercel functions cap execution (this project sets `maxDuration = 60s`; raise to `800` on Pro/Enterprise). Starting a job returns fast, so this is fine. Do **not** add a synchronous "start and wait until the job finishes" tool here — polling a long run will hit the timeout. Use `start_job` then poll `get_job_status` from the agent side instead.

---

## Tools

| Tool | Purpose |
|------|---------|
| `list_folders` | List accessible folders (OrganizationUnits) and their Ids. |
| `list_processes` | List runnable processes (Releases) in a folder; returns each `releaseKey`. |
| `list_queues` | List queues (QueueDefinitions) in a folder. |
| `start_job` | Start a process by **name** (auto-resolved) or `releaseKey`. |
| `get_job_status` | Job state, timing, and output arguments by `jobId`. |
| `list_jobs` | Recent jobs, newest first; optional state filter. |
| `stop_job` | Stop (`SoftStop`) or kill (`Kill`) a running job. |
| `add_queue_item` | Add an item to a queue by **name** (auto-resolved) or `queueId`. |

---

## 1. Create an External Application in Orchestrator

OAuth 2.0 **client credentials** (no user login — ideal for an agent).

1. Orchestrator → **Admin → External Applications → + Add Application**.
2. **Type:** Confidential application.
3. **Resources → Orchestrator API Access**, add **Application Scope** permissions. Minimum:
   - `OR.Folders.Read` (or `OR.Folders`)
   - `OR.Execution`, `OR.Jobs`
   - `OR.Queues`
4. Save; copy the **App ID** and **App Secret**.
5. Ensure the app has access to the **folders** you'll operate in.

---

## 2. Deploy to Vercel

**Option A — Dashboard (simplest):**

1. Push this folder to a GitHub repo.
2. [vercel.com/new](https://vercel.com/new) → **Import** the repo. Framework preset: **Next.js** (auto-detected).
3. Before deploying, open **Environment Variables** and add everything from `.env.example` (see the "Environment variables" section below).
4. **Deploy.** You'll get `https://<your-app>.vercel.app`.
5. **Enable Fluid Compute:** Project → **Settings → Functions → Fluid Compute → On** (better for MCP's bursty traffic and warm token reuse).

**Option B — CLI:**

```bash
npm i -g vercel
vercel            # link & first deploy (preview)
vercel env add    # add each variable (or paste in the dashboard)
vercel --prod     # production deploy
```

---

## 3. Environment variables

Add these in **Vercel → Settings → Environment Variables** (and `.env.local` for local dev). Full reference in `.env.example`.

| Variable | Required | Notes |
|----------|----------|-------|
| `UIPATH_DEPLOYMENT` | yes | `cloud` or `selfhosted` |
| `UIPATH_BASE_URL` | cloud: optional | Defaults to `https://cloud.uipath.com`; required for self-hosted |
| `UIPATH_ORG_NAME` | cloud: yes | From the Orchestrator URL `/{org}/{tenant}/` |
| `UIPATH_TENANT_NAME` | cloud: yes | From the Orchestrator URL |
| `UIPATH_CLIENT_ID` | yes | External App ID |
| `UIPATH_CLIENT_SECRET` | yes | External App Secret |
| `UIPATH_SCOPES` | yes | e.g. `OR.Folders.Read OR.Execution OR.Jobs OR.Queues` |
| `UIPATH_DEFAULT_FOLDER_ID` | recommended | So the agent needn't pass a folder each call |
| `MCP_AUTH_TOKEN` | strongly recommended | Long random string; nuwacom sends it as `Bearer` |
| `UIPATH_IDENTITY_URL` | optional | Override token endpoint for unusual topologies |

After changing env vars, **redeploy** (Vercel → Deployments → ⋯ → Redeploy) so they take effect.

---

## 4. Verify

```bash
curl https://<your-app>.vercel.app/healthz
# { "ok": true, "tools": [...], "configOk": true, "authEnabled": true, ... }
```

Test the MCP endpoint with any MCP client (e.g. the MCP Inspector), pointing it at:

```
https://<your-app>.vercel.app/api/mcp
```

with header `Authorization: Bearer <MCP_AUTH_TOKEN>`.

---

## 5. Register in nuwacom

1. nuwacom → **Workspace Settings → Connectors → Manage connectors** (admin).
2. Add a **custom MCP server**:
   - **URL:** `https://<your-app>.vercel.app/api/mcp`
   - **Header:** `Authorization: Bearer <MCP_AUTH_TOKEN>`
3. Save and enable for the workspace.

(If you don't see the custom-MCP option, contact your nuwacom admin / support@nuwacom.ai — it's an admin/advanced feature.)

---

## 6. Add the tools to an agent

Example agent task:

> When the user asks to run a process, call `list_processes` if you don't recognize the name, then `start_job`. Report the `jobId`. If they ask how it's going, call `get_job_status` with that id. To queue work for later, call `add_queue_item`.

Because `start_job` and `add_queue_item` accept human names, prompts like *"run the Invoice Bot for invoice A-123"* work without a separate lookup step.

---

## Local development

```bash
npm install
cp .env.example .env.local   # fill in values
npm run dev                  # http://localhost:3000/api/mcp
```

---

## Security notes

- This endpoint can **start and stop production automations**. Always set `MCP_AUTH_TOKEN`.
- Vercel serves HTTPS by default — good. Consider enabling **Vercel Firewall** / Deployment Protection on preview URLs.
- Scope the External Application to least privilege; prefer read scopes plus only the execution scopes you need.
- Secrets live in Vercel's encrypted env store — never commit `.env.local`.

## Notes & limits

- **Modern vs. classic folders:** `start_job` uses the `ModernJobsCount` strategy (Orchestrator picks robots). For classic folders that require explicit `RobotIds`, extend `start_job`.
- **`add_queue_item`** uses the `Queues/UiPathODataSvc.AddQueueItem` action keyed on queue name. If your Orchestrator version differs, that's the place to adjust.
- **High concurrency:** if you later run at scale and want to avoid occasional duplicate token fetches across cold instances, swap `getAccessToken()` in `lib/orchestrator.ts` to read/write Upstash Redis.
