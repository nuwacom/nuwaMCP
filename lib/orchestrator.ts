// lib/orchestrator.ts
// Thin client over the UiPath Orchestrator OData API.
// Handles OAuth 2.0 client-credentials token lifecycle and works against
// both UiPath Automation Cloud and self-hosted / Automation Suite instances.
//
// SERVERLESS NOTE (Vercel):
// The token is cached in a module-level variable. On Vercel Fluid compute a warm
// function instance is reused across invocations, so the cache is hit on most
// calls. On a cold start the variable resets and we simply fetch a fresh token —
// which is cheap and correct. No external cache (Redis) is required because
// Orchestrator calls return quickly and tokens last ~1 hour. If you later run at
// high concurrency and want to avoid occasional duplicate token fetches, swap
// getAccessToken() to read/write Upstash Redis.

type Json = any;

interface RequestOpts {
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
  folderId?: number | string;
  folderPath?: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

function optional(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function deployment(): string {
  return (optional("UIPATH_DEPLOYMENT", "cloud") as string).toLowerCase();
}
function isCloud(): boolean {
  return deployment() === "cloud";
}
function baseUrl(): string {
  const b = (optional("UIPATH_BASE_URL", isCloud() ? "https://cloud.uipath.com" : undefined) || "").replace(/\/+$/, "");
  if (!b) throw new Error("UIPATH_BASE_URL is required for self-hosted deployments.");
  return b;
}
function defaultFolderId(): string | undefined {
  return optional("UIPATH_DEFAULT_FOLDER_ID");
}

/**
 * Build the Orchestrator root URL (everything before /odata).
 *   Cloud / Automation Suite:  {BASE_URL}/{org}/{tenant}/orchestrator_
 *   Classic standalone:        {BASE_URL}
 */
function orchestratorRoot(): string {
  const org = optional("UIPATH_ORG_NAME");
  const tenant = optional("UIPATH_TENANT_NAME");
  if (isCloud()) {
    const o = org || required("UIPATH_ORG_NAME");
    const t = tenant || required("UIPATH_TENANT_NAME");
    return `${baseUrl()}/${o}/${t}/orchestrator_`;
  }
  if (org && tenant) {
    return `${baseUrl()}/${org}/${tenant}/orchestrator_`;
  }
  return baseUrl();
}

/** OAuth token endpoint. Overridable via UIPATH_IDENTITY_URL. */
function tokenEndpoint(): string {
  const override = optional("UIPATH_IDENTITY_URL");
  if (override) return override.replace(/\/+$/, "");
  return `${baseUrl()}/identity_/connect/token`;
}

// ---- token cache (module-level; survives warm invocations) ----
let cachedToken: string | null = null;
let cachedExpiry = 0; // epoch ms

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedExpiry - 60_000) {
    return cachedToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: required("UIPATH_CLIENT_ID"),
    client_secret: required("UIPATH_CLIENT_SECRET"),
    scope: required("UIPATH_SCOPES"),
  });

  const res = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OAuth token request failed (${res.status} ${res.statusText}). ` +
        `Check UIPATH_CLIENT_ID / UIPATH_CLIENT_SECRET / UIPATH_SCOPES and that the external app is registered. ` +
        `Response: ${text.slice(0, 500)}`
    );
  }

  const json: Json = await res.json();
  cachedToken = json.access_token;
  const expiresInSec = Number(json.expires_in) || 3600;
  cachedExpiry = now + expiresInSec * 1000;
  return cachedToken as string;
}

/** Core request helper against the Orchestrator OData API. */
async function request(method: string, path: string, opts: RequestOpts = {}): Promise<Json> {
  const token = await getAccessToken();
  const url = new URL(`${orchestratorRoot()}${path}`);

  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const folderId = opts.folderId ?? defaultFolderId();
  if (opts.folderPath) {
    headers["X-UIPATH-FolderPath-Encoded"] = encodeURIComponent(opts.folderPath);
  } else if (folderId !== undefined && folderId !== null && String(folderId) !== "") {
    headers["X-UIPATH-OrganizationUnitId"] = String(folderId);
  }

  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const raw = await res.text();
  let parsed: Json = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }

  if (!res.ok) {
    const detail =
      parsed && typeof parsed === "object" ? JSON.stringify(parsed) : String(parsed || "").slice(0, 800);
    const hint =
      res.status === 403
        ? " (403: the external app likely lacks the required scope, or the folder is wrong.)"
        : res.status === 401
        ? " (401: token rejected — check scopes / app registration.)"
        : "";
    throw new Error(`Orchestrator API ${method} ${path} failed: ${res.status} ${res.statusText}.${hint} ${detail}`);
  }

  return parsed;
}

export const orchestrator = {
  request,
  getAccessToken,
  orchestratorRoot,
  get config() {
    return {
      deployment: deployment(),
      isCloud: isCloud(),
      orgName: optional("UIPATH_ORG_NAME"),
      tenantName: optional("UIPATH_TENANT_NAME"),
      defaultFolderId: defaultFolderId(),
    };
  },
};
