import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isXaiProvider,
  XAI_GROK_CLI_AUTH_SCOPE_KEY,
  XAI_GROK_CLI_LEGACY_AUTH_SCOPE_KEY,
  XAI_PROVIDER_IDS,
  type XaiProviderId,
} from "./constants";

export interface OAuthCredential {
  kind: "oauth-session";
  token: string;
}

function parseExpiry(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function tokenFromAuthResolution(auth: {
  ok?: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
} | null | undefined): string | null {
  if (!auth?.ok) return null;
  if (typeof auth.apiKey === "string" && auth.apiKey) return auth.apiKey;
  const authorization =
    typeof auth.headers?.Authorization === "string" ? auth.headers.Authorization : "";
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim() || null
    : null;
}

function registryUsesOAuth(registry: any, model: any, providerId: string): boolean {
  try {
    if (typeof registry?.isUsingOAuth === "function" && registry.isUsingOAuth(model) === true) {
      return true;
    }
    if (typeof registry?.authStorage?.get === "function") {
      const stored = registry.authStorage.get(providerId);
      return stored?.type === "oauth" && typeof stored.access === "string" && !!stored.access;
    }
    if (typeof registry?.getProviderAuthStatus === "function") {
      const status = registry.getProviderAuthStatus(providerId);
      return status?.configured === true && status.source === "stored";
    }
  } catch {
    return false;
  }
  return false;
}

async function resolveRegistryToken(
  registry: any,
  model: any,
  modelRuntime: any,
): Promise<string | null> {
  if (modelRuntime && typeof modelRuntime.getAuth === "function") {
    try {
      return tokenFromAuthResolution(await modelRuntime.getAuth(model));
    } catch {
      // Fall through to registry projections.
    }
  }
  if (registry && typeof registry.getAuth === "function") {
    try {
      return tokenFromAuthResolution(await registry.getAuth(model));
    } catch {
      // Fall through.
    }
  }
  if (typeof registry?.getApiKeyAndHeaders === "function") {
    try {
      return tokenFromAuthResolution(await registry.getApiKeyAndHeaders(model));
    } catch {
      // Fall through.
    }
  }
  if (typeof registry?.getProviderAuth === "function") {
    try {
      const providerId = typeof model?.provider === "string" ? model.provider : undefined;
      return tokenFromAuthResolution(await registry.getProviderAuth(providerId));
    } catch {
      return null;
    }
  }
  return null;
}

function providerIdsFor(ctx: any): XaiProviderId[] {
  if (isXaiProvider(ctx?.model?.provider)) return [ctx.model.provider];
  return [...XAI_PROVIDER_IDS];
}

/** True when Pi currently has an xAI OAuth credential available for usage lookups. */
export function hasXaiOAuth(ctx: any): boolean {
  const registry = ctx?.modelRegistry;
  if (!registry) return false;
  for (const providerId of providerIdsFor(ctx)) {
    const candidates = [
      ctx?.model?.provider === providerId ? ctx.model : undefined,
      typeof registry.find === "function" ? registry.find(providerId, "grok-4.5") : undefined,
    ].filter(Boolean);
    if (candidates.some((model) => registryUsesOAuth(registry, model, providerId))) {
      return true;
    }
  }
  if (readPiStoredOAuthToken() || readGrokCliToken()) return true;
  return false;
}

function readJsonFile(path: string): any | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function agentDir(): string {
  // Prefer PI_AGENT_DIR when set (tests / custom installs); otherwise ~/.pi/agent.
  const override = process.env.PI_AGENT_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".pi", "agent");
}

function oauthAccessFromStored(stored: any): string | null {
  if (stored?.type === "oauth" && typeof stored.access === "string" && stored.access) {
    const expires = parseExpiry(stored.expires);
    if (expires !== undefined && expires <= Date.now()) return null;
    return stored.access;
  }
  return null;
}

function readPiStoredOAuthToken(): string | null {
  const data = readJsonFile(join(agentDir(), "auth.json"));
  if (!data || typeof data !== "object") return null;
  for (const providerId of XAI_PROVIDER_IDS) {
    const token = oauthAccessFromStored(data[providerId]);
    if (token) return token;
  }
  return null;
}

/** Read-only reuse of official Grok CLI credentials at ~/.grok/auth.json. */
export function readGrokCliToken(): string | null {
  const data = readJsonFile(join(homedir(), ".grok", "auth.json"));
  if (!data || typeof data !== "object") return null;

  const oidc = data[XAI_GROK_CLI_AUTH_SCOPE_KEY];
  if (oidc && typeof oidc === "object") {
    const access = String(oidc.key || oidc.access_token || oidc.token || "");
    if (access) {
      const expires = parseExpiry(oidc.expires_at);
      if (expires !== undefined && expires <= Date.now()) return null;
      return access;
    }
  }

  const legacy = data[XAI_GROK_CLI_LEGACY_AUTH_SCOPE_KEY];
  if (legacy && typeof legacy === "object") {
    const access = String(legacy.key || legacy.access_token || legacy.token || "");
    if (access) return access;
  }

  const top = data.access_token || data.token;
  return typeof top === "string" && top ? top : null;
}

/**
 * Resolve an OAuth bearer for the unofficial usage surface.
 * Rejects API-key-only provenance when the active provider is known non-OAuth.
 */
export async function resolveOAuthCredential(ctx: any): Promise<OAuthCredential | null> {
  const registry = ctx?.modelRegistry;
  const modelRuntime = ctx?.modelRuntime;

  if (registry && typeof registry.find === "function") {
    for (const providerId of providerIdsFor(ctx)) {
      const models = [
        ctx?.model?.provider === providerId ? ctx.model : undefined,
        registry.find(providerId, ctx?.model?.provider === providerId ? ctx.model.id : "grok-4.5"),
        registry.find(providerId, "grok-4.5"),
      ].filter(Boolean);

      for (const model of models) {
        if (!registryUsesOAuth(registry, model, providerId)) continue;
        const token = await resolveRegistryToken(registry, model, modelRuntime);
        if (token) return { kind: "oauth-session", token };
      }
    }
  }

  const stored = readPiStoredOAuthToken();
  if (stored) return { kind: "oauth-session", token: stored };

  const grok = readGrokCliToken();
  if (grok) return { kind: "oauth-session", token: grok };

  return null;
}
