import { describe, expect, it, vi } from "vitest";
import { registerUsage, type UsageSnapshot } from "../extensions/usage";

const usage: UsageSnapshot = {
  creditUsagePercent: 25,
  currentPeriod: { end: "2026-08-01T00:00:00Z" },
  history: [],
};

function createHarness() {
  const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
  const api = {
    registerCommand(name: string, def: { description: string; handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, def);
    },
  };
  return { api: api as any, commands };
}

function setup(model: any = { provider: "xai-auth", id: "grok-4.5" }) {
  const harness = createHarness();
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses: Array<{ key: string; text?: string }> = [];
  let now = 1_000;
  const resolveCredential = vi.fn(async () => ({ kind: "oauth-session" as const, token: "SECRET" }));
  const fetchUsage = vi.fn(async () => usage);
  const feature = registerUsage(harness.api, {
    resolveCredential,
    fetchUsage,
    now: () => now,
    minimumRefreshMs: 60_000,
    defaultStatusOn: true,
  });
  const ctx = {
    model,
    signal: undefined,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === model.provider ? { ...model, provider, id } : undefined,
      isUsingOAuth: () => true,
      authStorage: {
        get: () => ({ type: "oauth", access: "SECRET", expires: Date.now() + 60_000 }),
      },
    },
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
      setStatus(key: string, text: string | undefined) {
        statuses.push({ key, text });
      },
    },
  };
  const run = (args: string) => harness.commands.get("grok-usage")!.handler(args, ctx as any);
  return {
    ctx: ctx as any,
    feature,
    fetchUsage,
    harness,
    notifications,
    resolveCredential,
    run,
    statuses,
    setNow(value: number) {
      now = value;
    },
    setModel(next: any) {
      ctx.model = next;
    },
  };
}

describe("/grok-usage command and status lifecycle", () => {
  it("registers the command and shows a one-shot report", async () => {
    const { fetchUsage, harness, notifications, run, statuses } = setup();
    expect(harness.commands.has("grok-usage")).toBe(true);
    await run("");
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(notifications.at(-1)?.type).toBe("info");
    expect(notifications.at(-1)?.message).toContain("Included usage: 25% used");
    // default status on also updates footer from the one-shot
    expect(statuses.at(-1)?.key).toBe("pi-grok-usage");
    expect(statuses.at(-1)?.text).toMatch(/^SuperGrok 75% \(/);
  });

  it("validates arguments", async () => {
    const { notifications, run } = setup();
    await run("enable");
    expect(notifications.at(-1)?.message).toBe("Usage: /grok-usage [status [on|off]]");
  });

  it("can disable and re-enable status", async () => {
    const state = setup();
    await state.run("status off");
    expect(state.statuses.at(-1)).toEqual({ key: "pi-grok-usage", text: undefined });
    await state.run("status");
    expect(state.notifications.at(-1)?.message).toMatch(/status is off/);

    await state.run("status on");
    expect(state.fetchUsage).toHaveBeenCalled();
    expect(state.statuses.at(-1)?.text).toMatch(/^SuperGrok 75% \(/);
  });

  it("clears status for non-xAI models but keeps preference", async () => {
    const state = setup();
    await state.feature.syncForModel(state.ctx);
    expect(state.statuses.at(-1)?.text).toMatch(/^SuperGrok /);

    state.setModel({ provider: "anthropic", id: "claude" });
    await state.feature.syncForModel(state.ctx);
    expect(state.statuses.at(-1)).toEqual({ key: "pi-grok-usage", text: undefined });
  });

  it("rate-limits refreshStatus after success", async () => {
    const state = setup();
    await state.feature.refreshStatus(state.ctx);
    await state.feature.refreshStatus(state.ctx);
    expect(state.fetchUsage).toHaveBeenCalledTimes(1);
    state.setNow(70_000);
    await state.feature.refreshStatus(state.ctx);
    expect(state.fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("retries promptly after a failed refresh", async () => {
    const state = setup();
    state.fetchUsage.mockRejectedValueOnce(new Error("timeout"));
    await state.feature.refreshStatus(state.ctx);
    expect(state.statuses.at(-1)).toEqual({ key: "pi-grok-usage", text: undefined });
    await state.feature.refreshStatus(state.ctx);
    expect(state.fetchUsage).toHaveBeenCalledTimes(2);
    expect(state.statuses.at(-1)?.text).toMatch(/^SuperGrok 75% \(/);
  });
});
