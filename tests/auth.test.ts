import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasXaiOAuth,
  readGrokCliToken,
  readPiStoredOAuthToken,
  registryUsesOAuth,
  resolveOAuthCredential,
  tokenFromAuthResolution,
} from "../extensions/auth";
import { XAI_GROK_CLI_AUTH_SCOPE_KEY } from "../extensions/constants";

const cleanupDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-grok-usage-"));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.PI_AGENT_DIR;
  delete process.env.PI_GROK_AUTH_PATH;
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("tokenFromAuthResolution", () => {
  it("parses getApiKeyAndHeaders shape", () => {
    expect(tokenFromAuthResolution({ ok: true, apiKey: "tok-a" })).toBe("tok-a");
    expect(tokenFromAuthResolution({ ok: false, apiKey: "tok-a" })).toBeNull();
    expect(
      tokenFromAuthResolution({
        ok: true,
        headers: { Authorization: "Bearer tok-b" },
      }),
    ).toBe("tok-b");
  });

  it("parses Pi AuthResult shape", () => {
    expect(tokenFromAuthResolution({ auth: { apiKey: "tok-c" } })).toBe("tok-c");
    expect(
      tokenFromAuthResolution({
        auth: { headers: { Authorization: "Bearer tok-d" } },
        source: "oauth",
      }),
    ).toBe("tok-d");
  });
});

describe("registryUsesOAuth", () => {
  it("honors isUsingOAuth false for API-key sessions", () => {
    const model = { provider: "xai", id: "grok-4.5" };
    const registry = {
      isUsingOAuth: () => false,
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      authStorage: {
        get: () => ({ type: "api_key", key: "sk-secret" }),
      },
    };
    expect(registryUsesOAuth(registry, model, "xai")).toBe(false);
  });

  it("returns true when isUsingOAuth is true", () => {
    const model = { provider: "xai", id: "grok-4.5" };
    expect(registryUsesOAuth({ isUsingOAuth: () => true }, model, "xai")).toBe(true);
  });

  it("uses authStorage type when isUsingOAuth is missing", () => {
    const model = { provider: "xai", id: "grok-4.5" };
    expect(
      registryUsesOAuth(
        { authStorage: { get: () => ({ type: "oauth", access: "oauth-tok" }) } },
        model,
        "xai",
      ),
    ).toBe(true);
    expect(
      registryUsesOAuth(
        { authStorage: { get: () => ({ type: "api_key", key: "sk" }) } },
        model,
        "xai",
      ),
    ).toBe(false);
  });
});

describe("file-based OAuth", () => {
  it("reads Pi auth.json OAuth and rejects expired tokens", () => {
    const dir = tempDir();
    process.env.PI_AGENT_DIR = dir;
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        xai: {
          type: "oauth",
          access: "pi-oauth-token",
          expires: Date.now() + 60_000,
        },
      }),
    );
    expect(readPiStoredOAuthToken()).toBe("pi-oauth-token");

    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        xai: {
          type: "oauth",
          access: "expired",
          expires: Date.now() - 1,
        },
      }),
    );
    expect(readPiStoredOAuthToken()).toBeNull();
  });

  it("ignores API-key entries in Pi auth.json", () => {
    const dir = tempDir();
    process.env.PI_AGENT_DIR = dir;
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ xai: { type: "api_key", key: "sk-xai" } }),
    );
    expect(readPiStoredOAuthToken()).toBeNull();
  });

  it("reads Grok CLI OAuth via PI_GROK_AUTH_PATH", () => {
    const dir = tempDir();
    const path = join(dir, "auth.json");
    process.env.PI_GROK_AUTH_PATH = path;
    writeFileSync(
      path,
      JSON.stringify({
        [XAI_GROK_CLI_AUTH_SCOPE_KEY]: {
          key: "grok-cli-token",
          expires_at: Date.now() + 60_000,
        },
      }),
    );
    expect(readGrokCliToken()).toBe("grok-cli-token");
  });
});

describe("resolveOAuthCredential", () => {
  it("returns registry OAuth token when isUsingOAuth is true", async () => {
    const model = { provider: "xai", id: "grok-4.5" };
    const ctx = {
      model,
      modelRegistry: {
        find: (provider: string) => (provider === "xai" ? model : undefined),
        isUsingOAuth: () => true,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "registry-oauth" }),
      },
    };
    await expect(resolveOAuthCredential(ctx)).resolves.toEqual({
      kind: "oauth-session",
      token: "registry-oauth",
    });
  });

  it("skips API-key registry and falls back to Grok CLI file", async () => {
    const dir = tempDir();
    process.env.PI_GROK_AUTH_PATH = join(dir, "auth.json");
    writeFileSync(
      process.env.PI_GROK_AUTH_PATH,
      JSON.stringify({
        [XAI_GROK_CLI_AUTH_SCOPE_KEY]: { key: "file-oauth", expires_at: Date.now() + 60_000 },
      }),
    );
    // Empty PI agent dir so only Grok CLI path can succeed.
    process.env.PI_AGENT_DIR = tempDir();
    writeFileSync(join(process.env.PI_AGENT_DIR, "auth.json"), "{}");

    const model = { provider: "xai", id: "grok-4.5" };
    const ctx = {
      model,
      modelRegistry: {
        find: (provider: string) => (provider === "xai" ? model : undefined),
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-api-key" }),
        getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      },
    };
    await expect(resolveOAuthCredential(ctx)).resolves.toEqual({
      kind: "oauth-session",
      token: "file-oauth",
    });
    expect(hasXaiOAuth(ctx)).toBe(true);
  });

  it("returns null for API-key-only with no file OAuth", async () => {
    process.env.PI_AGENT_DIR = tempDir();
    writeFileSync(join(process.env.PI_AGENT_DIR, "auth.json"), "{}");
    process.env.PI_GROK_AUTH_PATH = join(tempDir(), "missing.json");

    const model = { provider: "xai", id: "grok-4.5" };
    const ctx = {
      model,
      modelRegistry: {
        find: (provider: string) => (provider === "xai" ? model : undefined),
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-api-key" }),
      },
    };
    await expect(resolveOAuthCredential(ctx)).resolves.toBeNull();
    expect(hasXaiOAuth(ctx)).toBe(false);
  });

  it("parses AuthResult from modelRuntime.getAuth", async () => {
    const model = { provider: "xai-auth", id: "grok-4.5" };
    const ctx = {
      model,
      modelRuntime: {
        getAuth: async () => ({ auth: { apiKey: "runtime-oauth" } }),
      },
      modelRegistry: {
        find: (provider: string) => (provider === "xai-auth" ? model : undefined),
        isUsingOAuth: () => true,
      },
    };
    await expect(resolveOAuthCredential(ctx)).resolves.toEqual({
      kind: "oauth-session",
      token: "runtime-oauth",
    });
  });
});
