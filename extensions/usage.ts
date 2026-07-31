import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { hasXaiOAuth, resolveOAuthCredential, type OAuthCredential } from "./auth";
import {
  COMMAND_HELP,
  isXaiProvider,
  PACKAGE_VERSION,
  STATUS_KEY,
  USAGE_MAX_HISTORY_PERIODS,
  USAGE_MAX_JSON_ARRAY_ITEMS,
  USAGE_MAX_JSON_DEPTH,
  USAGE_MAX_JSON_NODES,
  USAGE_MAX_JSON_OBJECT_KEYS,
  USAGE_MAX_RESPONSE_BYTES,
  USAGE_STATUS_MIN_REFRESH_MS,
  USAGE_TIMEOUT_MS,
  XAI_CLI_BILLING_URL,
  XAI_CLI_USER_URL,
} from "./constants";

export interface UsagePeriod {
  type?: string;
  start?: string;
  end?: string;
}

export interface UsageHistoryPeriod {
  period?: UsagePeriod;
  billingCycle?: { year: number; month: number };
  includedUsedCents?: number;
  onDemandUsedCents?: number;
  totalUsedCents?: number;
}

export interface UsageSnapshot {
  creditUsagePercent?: number;
  currentPeriod?: UsagePeriod;
  monthlyLimitCents?: number;
  usedCents?: number;
  onDemandCapCents?: number;
  onDemandUsedCents?: number;
  prepaidBalanceCents?: number;
  isUnifiedBillingUser?: boolean;
  onDemandEnabled?: boolean;
  subscriptionTier?: string;
  history: UsageHistoryPeriod[];
}

type UsageErrorCode =
  | "auth"
  | "cancelled"
  | "http"
  | "invalid"
  | "oversize"
  | "timeout"
  | "transport";

export class UsageError extends Error {
  readonly code: UsageErrorCode;
  readonly status?: number;

  constructor(code: UsageErrorCode, message: string, status?: number) {
    super(message);
    this.name = "UsageError";
    this.code = code;
    this.status = status;
  }
}

const MAX_USER_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 80;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_CENTS = 1_000_000_000_000;
const MIN_BILLING_YEAR = 2000;
const MAX_BILLING_YEAR = 2200;
const USER_ID_PATTERN = /^[\x21-\x7e]+$/;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

interface JsonBudget {
  nodes: number;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertBoundedJson(value: unknown, depth = 0, budget: JsonBudget = { nodes: 0 }): void {
  if (depth > USAGE_MAX_JSON_DEPTH || ++budget.nodes > USAGE_MAX_JSON_NODES) {
    throw new UsageError("invalid", "xAI usage returned an over-complex response.");
  }
  if (Array.isArray(value)) {
    if (value.length > USAGE_MAX_JSON_ARRAY_ITEMS) {
      throw new UsageError("invalid", "xAI usage returned too many response entries.");
    }
    for (const item of value) assertBoundedJson(item, depth + 1, budget);
    return;
  }
  const obj = objectValue(value);
  if (!obj) return;
  const values = Object.values(obj);
  if (values.length > USAGE_MAX_JSON_OBJECT_KEYS) {
    throw new UsageError("invalid", "xAI usage returned too many response fields.");
  }
  for (const item of values) assertBoundedJson(item, depth + 1, budget);
}

function boundedLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  return label && label.length <= MAX_LABEL_LENGTH && !/[\u0000-\u001f\u007f]/.test(label)
    ? label
    : undefined;
}

function boundedTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_TIMESTAMP_LENGTH) return undefined;
  const match = value.match(RFC3339_PATTERN);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
    || !Number.isFinite(Date.parse(value))
  ) {
    return undefined;
  }
  return value;
}

function boundedPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function boundedCents(value: unknown): number | undefined {
  const wrapper = objectValue(value);
  if (!wrapper) return undefined;
  const cents = wrapper.val === undefined ? 0 : wrapper.val;
  return typeof cents === "number"
    && Number.isSafeInteger(cents)
    && cents >= 0
    && cents <= MAX_CENTS
    ? cents
    : undefined;
}

function usagePeriod(value: unknown): UsagePeriod | undefined {
  const obj = objectValue(value);
  if (!obj) return undefined;
  const result: UsagePeriod = {};
  const type = boundedLabel(obj.type);
  const start = boundedTimestamp(obj.start);
  const end = boundedTimestamp(obj.end);
  if (type) result.type = type;
  if (start) result.start = start;
  if (end) result.end = end;
  return Object.keys(result).length > 0 ? result : undefined;
}

function billingCycle(value: unknown): { year: number; month: number } | undefined {
  const obj = objectValue(value);
  if (!obj) return undefined;
  const { year, month } = obj;
  return Number.isSafeInteger(year)
    && Number.isSafeInteger(month)
    && (year as number) >= MIN_BILLING_YEAR
    && (year as number) <= MAX_BILLING_YEAR
    && (month as number) >= 1
    && (month as number) <= 12
    ? { year: year as number, month: month as number }
    : undefined;
}

function historyPeriod(value: unknown): UsageHistoryPeriod | undefined {
  const obj = objectValue(value);
  if (!obj) return undefined;
  const result: UsageHistoryPeriod = {};
  const period = usagePeriod(obj.period);
  const cycle = billingCycle(obj.billingCycle);
  const included = boundedCents(obj.includedUsed);
  const onDemand = boundedCents(obj.onDemandUsed);
  const total = boundedCents(obj.totalUsed);
  if (period) result.period = period;
  if (cycle) result.billingCycle = cycle;
  if (included !== undefined) result.includedUsedCents = included;
  if (onDemand !== undefined) result.onDemandUsedCents = onDemand;
  if (total !== undefined) result.totalUsedCents = total;
  return Object.keys(result).length > 0 ? result : undefined;
}

export function parseUserId(value: unknown): string {
  assertBoundedJson(value);
  const userId = objectValue(value)?.userId;
  if (
    typeof userId !== "string"
    || !userId
    || userId.length > MAX_USER_ID_LENGTH
    || !USER_ID_PATTERN.test(userId)
  ) {
    throw new UsageError(
      "invalid",
      "xAI account identity could not be verified; billing was not requested.",
    );
  }
  return userId;
}

export function parseUsage(value: unknown): UsageSnapshot {
  assertBoundedJson(value);
  const root = objectValue(value);
  if (!root) throw new UsageError("invalid", "xAI usage returned an invalid response.");
  if (root.config !== undefined && root.config !== null && !objectValue(root.config)) {
    throw new UsageError("invalid", "xAI usage returned an invalid response.");
  }
  const config = objectValue(root.config);
  const snapshot: UsageSnapshot = { history: [] };
  if (typeof root.onDemandEnabled === "boolean") snapshot.onDemandEnabled = root.onDemandEnabled;
  const tier = boundedLabel(root.subscriptionTier);
  if (tier) snapshot.subscriptionTier = tier;
  if (!config) return snapshot;

  const history = config.history;
  if (history !== undefined && !Array.isArray(history)) {
    throw new UsageError("invalid", "xAI usage returned invalid billing history.");
  }
  if (Array.isArray(history) && history.length > USAGE_MAX_HISTORY_PERIODS) {
    throw new UsageError("invalid", "xAI usage returned too many billing periods.");
  }

  const percent = boundedPercent(config.creditUsagePercent);
  const currentPeriod = usagePeriod(config.currentPeriod);
  const monthlyLimit = boundedCents(config.monthlyLimit);
  const used = boundedCents(config.used);
  const onDemandCap = boundedCents(config.onDemandCap);
  const onDemandUsed = boundedCents(config.onDemandUsed);
  const prepaid = boundedCents(config.prepaidBalance);
  if (percent !== undefined) snapshot.creditUsagePercent = percent;
  if (currentPeriod) snapshot.currentPeriod = currentPeriod;
  if (monthlyLimit !== undefined) snapshot.monthlyLimitCents = monthlyLimit;
  if (used !== undefined) snapshot.usedCents = used;
  if (onDemandCap !== undefined) snapshot.onDemandCapCents = onDemandCap;
  if (onDemandUsed !== undefined) snapshot.onDemandUsedCents = onDemandUsed;
  if (prepaid !== undefined) snapshot.prepaidBalanceCents = prepaid;
  if (typeof config.isUnifiedBillingUser === "boolean") {
    snapshot.isUnifiedBillingUser = config.isUnifiedBillingUser;
  }
  const fallbackStart = boundedTimestamp(config.billingPeriodStart);
  const fallbackEnd = boundedTimestamp(config.billingPeriodEnd);
  if (!snapshot.currentPeriod && (fallbackStart || fallbackEnd)) {
    snapshot.currentPeriod = {
      ...(fallbackStart ? { start: fallbackStart } : {}),
      ...(fallbackEnd ? { end: fallbackEnd } : {}),
    };
  }
  if (Array.isArray(history)) {
    snapshot.history = history
      .map(historyPeriod)
      .filter((entry): entry is UsageHistoryPeriod => entry !== undefined);
  }
  return snapshot;
}

function usageHeaders(accessToken: string, userId?: string): Record<string, string> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": PACKAGE_VERSION,
    "x-grok-client-mode": interactive ? "interactive" : "headless",
    ...(userId ? { "x-userid": userId } : {}),
  };
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  const abortError = () => new DOMException("The operation was cancelled.", "AbortError");
  let rejectOnAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => rejectOnAbort?.(signal.reason ?? abortError());
  const cancelReader = () => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // best-effort
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) throw signal.reason ?? abortError();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > USAGE_MAX_RESPONSE_BYTES) {
        cancelReader();
        throw new UsageError("oversize", "xAI usage returned an oversized response.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError("invalid", "xAI usage returned an invalid response body.");
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) cancelReader();
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function httpError(status: number): UsageError {
  if (status === 401 || status === 403) {
    return new UsageError(
      "auth",
      "xAI authentication was rejected. Run /login xai or /login xai-auth and try again.",
      status,
    );
  }
  if (status === 404 || (status >= 300 && status < 400)) {
    return new UsageError("http", "The pinned xAI usage contract is unavailable.", status);
  }
  if (status === 429) {
    return new UsageError("http", "xAI usage is rate limited. Try again later.", status);
  }
  return new UsageError("http", `xAI usage request failed with status ${status}.`, status);
}

async function requestBoundedJson(
  url: string,
  credential: OAuthCredential,
  userId?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (credential.kind !== "oauth-session" || !credential.token) {
    throw new UsageError(
      "auth",
      "xAI OAuth credentials are required. Run /login xai or /login xai-auth first.",
    );
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, USAGE_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  if (signal?.aborted) controller.abort();

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: usageHeaders(credential.token, userId),
      });
    } catch {
      if (signal?.aborted) throw new UsageError("cancelled", "xAI usage request was cancelled.");
      if (timedOut) throw new UsageError("timeout", "xAI usage request timed out.");
      throw new UsageError("transport", "xAI usage request failed.");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw httpError(response.status);
    }
    let body: string;
    try {
      body = await readBoundedBody(response, controller.signal);
    } catch (error) {
      if (signal?.aborted) throw new UsageError("cancelled", "xAI usage request was cancelled.");
      if (timedOut) throw new UsageError("timeout", "xAI usage request timed out.");
      if (error instanceof UsageError) throw error;
      throw new UsageError("transport", "xAI usage request failed.");
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new UsageError("invalid", "xAI usage returned malformed JSON.");
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

/** Identity-first billing lookup: GET /user, then GET /billing?format=credits. */
export async function fetchUsage(
  credential: OAuthCredential,
  signal?: AbortSignal,
): Promise<UsageSnapshot> {
  const identity = await requestBoundedJson(XAI_CLI_USER_URL, credential, undefined, signal);
  const userId = parseUserId(identity);
  const billing = await requestBoundedJson(XAI_CLI_BILLING_URL, credential, userId, signal);
  return parseUsage(billing);
}

function formatPercent(value: number): string {
  return `${Number(value.toFixed(1))}%`;
}

function formatCents(value: number): string {
  return `$${(value / 100).toFixed(2)}`;
}

export function effectivePercent(usage: UsageSnapshot): number | undefined {
  if (usage.creditUsagePercent !== undefined) return usage.creditUsagePercent;
  if (
    usage.usedCents !== undefined
    && usage.monthlyLimitCents !== undefined
    && usage.monthlyLimitCents > 0
  ) {
    return Math.min(100, (usage.usedCents / usage.monthlyLimitCents) * 100);
  }
  return undefined;
}

/** Remaining included allowance (100 − used %), when percentage is known. */
export function remainingPercent(usage: UsageSnapshot): number | undefined {
  const used = effectivePercent(usage);
  return used === undefined ? undefined : Math.max(0, 100 - used);
}

function formatRemainingDuration(endIso: string, now = Date.now()): string | undefined {
  const end = Date.parse(endIso);
  if (!Number.isFinite(end)) return undefined;
  const ms = end - now;
  if (ms <= 0) return "soon";
  const totalHours = Math.floor(ms / (60 * 60 * 1000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  if (totalHours > 0) return `${totalHours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

/** Full local date/time for `/grok-usage` (e.g. `Jul 20, 2026, 8:00 AM`). */
export function formatReadableLocal(iso: string): string | undefined {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Full multi-line report for `/grok-usage`. */
export function renderUsage(usage: UsageSnapshot): string {
  const lines = ["Grok usage:"];
  const percent = effectivePercent(usage);
  const remaining = remainingPercent(usage);
  if (usage.subscriptionTier) lines.push(`Subscription: ${usage.subscriptionTier}`);
  if (percent !== undefined) {
    lines.push(`Included usage: ${formatPercent(percent)} used`);
    if (remaining !== undefined) lines.push(`Included remaining: ${formatPercent(remaining)}`);
  }
  if (usage.usedCents !== undefined || usage.monthlyLimitCents !== undefined) {
    lines.push(
      `Included credits: ${usage.usedCents !== undefined ? `${formatCents(usage.usedCents)} used` : "usage unavailable"}`
        + `${usage.monthlyLimitCents !== undefined ? ` of ${formatCents(usage.monthlyLimitCents)}` : ""}`,
    );
  }
  const periodStart = usage.currentPeriod?.start
    ? formatReadableLocal(usage.currentPeriod.start)
    : undefined;
  if (periodStart) lines.push(`Period start: ${periodStart}`);
  if (usage.currentPeriod?.end) {
    const when = formatReadableLocal(usage.currentPeriod.end) ?? usage.currentPeriod.end;
    const left = formatRemainingDuration(usage.currentPeriod.end);
    lines.push(`Reset: ${when}${left ? ` (${left})` : ""}`);
  }
  if (usage.onDemandUsedCents !== undefined || usage.onDemandCapCents !== undefined) {
    lines.push(
      `On-demand credits: ${usage.onDemandUsedCents !== undefined ? `${formatCents(usage.onDemandUsedCents)} used` : "usage unavailable"}`
        + `${usage.onDemandCapCents !== undefined ? ` of ${formatCents(usage.onDemandCapCents)}` : ""}`,
    );
  }
  if (usage.prepaidBalanceCents !== undefined) {
    lines.push(`Prepaid balance: ${formatCents(usage.prepaidBalanceCents)}`);
  }
  if (usage.onDemandEnabled !== undefined) {
    lines.push(`On-demand billing: ${usage.onDemandEnabled ? "enabled" : "disabled"}`);
  }
  if (usage.isUnifiedBillingUser !== undefined) {
    lines.push(`Usage pool: ${usage.isUnifiedBillingUser ? "unified" : "standard"}`);
  }
  if (usage.history.length > 0) lines.push(`Validated history periods: ${usage.history.length}`);
  if (lines.length === 1) lines.push("No supported usage fields were returned.");
  return lines.join("\n");
}

/** Format reset as local `M/D HH:mm` (e.g. `7/20 14:00`). */
export function formatResetLocal(iso: string): string | undefined {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hh = d.getHours().toString().padStart(2, "0");
  const min = d.getMinutes().toString().padStart(2, "0");
  return `${month}/${day} ${hh}:${min}`;
}

/** Compact footer status: `Grok 56.7% (7/20 14:00)`. */
export function renderUsageStatus(usage: UsageSnapshot, _now = Date.now()): string {
  const remaining = remainingPercent(usage);
  const used = effectivePercent(usage);
  let core: string;
  if (remaining !== undefined) {
    core = formatPercent(remaining);
  } else if (used !== undefined) {
    core = formatPercent(used);
  } else if (usage.usedCents !== undefined && usage.monthlyLimitCents !== undefined) {
    core = `${formatCents(usage.usedCents)}/${formatCents(usage.monthlyLimitCents)}`;
  } else if (usage.prepaidBalanceCents !== undefined) {
    core = formatCents(usage.prepaidBalanceCents);
  } else {
    core = "ok";
  }
  const when = usage.currentPeriod?.end
    ? formatResetLocal(usage.currentPeriod.end)
    : undefined;
  return when ? `Grok ${core} (${when})` : `Grok ${core}`;
}

export interface UsageFeature {
  reset(ctx?: any): void;
  syncForModel(ctx: any): Promise<void>;
  refreshStatus(ctx: any): Promise<void>;
}

interface UsageDependencies {
  resolveCredential: typeof resolveOAuthCredential;
  fetchUsage: typeof fetchUsage;
  now: () => number;
  minimumRefreshMs: number;
  /** When true, status auto-enables on xAI models (package default). */
  defaultStatusOn: boolean;
}

function safeUsageError(error: unknown): UsageError {
  return error instanceof UsageError
    ? error
    : new UsageError("transport", "xAI usage request failed.");
}

/** Register `/grok-usage` and session status lifecycle. */
export function registerUsage(
  pi: ExtensionAPI,
  overrides: Partial<UsageDependencies> = {},
): UsageFeature {
  const dependencies: UsageDependencies = {
    resolveCredential: overrides.resolveCredential ?? resolveOAuthCredential,
    fetchUsage: overrides.fetchUsage ?? fetchUsage,
    now: overrides.now ?? Date.now,
    minimumRefreshMs: overrides.minimumRefreshMs ?? USAGE_STATUS_MIN_REFRESH_MS,
    defaultStatusOn: overrides.defaultStatusOn ?? true,
  };

  let statusEnabled = dependencies.defaultStatusOn;
  let lastRefreshAt = 0;
  let generation = 0;
  let lastUi: ExtensionUIContext | undefined;
  let statusController: AbortController | undefined;
  let oneShotController: AbortController | undefined;
  let oneShotGeneration = 0;
  let refreshPromise: Promise<{ ok: boolean; error?: UsageError }> | undefined;

  const clear = (ctx?: any) => {
    const ui = ctx?.ui ?? lastUi;
    try {
      ui?.setStatus(STATUS_KEY, undefined);
    } catch {
      // cosmetic only
    }
    lastUi = ctx?.ui;
  };

  const reset = (ctx?: any, keepEnabled = false) => {
    if (!keepEnabled) statusEnabled = false;
    lastRefreshAt = 0;
    generation++;
    oneShotGeneration++;
    statusController?.abort();
    oneShotController?.abort();
    statusController = undefined;
    oneShotController = undefined;
    refreshPromise = undefined;
    clear(ctx);
  };

  const resolveUsage = async (ctx: any, signal?: AbortSignal) => {
    let credential: OAuthCredential | null;
    try {
      credential = await dependencies.resolveCredential(ctx);
    } catch {
      throw new UsageError(
        "auth",
        "xAI OAuth credentials could not be resolved. Run /login xai or /login xai-auth first.",
      );
    }
    if (!credential) {
      throw new UsageError(
        "auth",
        "xAI OAuth credentials are required. Run /login xai or /login xai-auth first.",
      );
    }
    return dependencies.fetchUsage(credential, signal);
  };

  const updateStatus = async (
    ctx: any,
    force: boolean,
  ): Promise<{ ok: boolean; error?: UsageError }> => {
    lastUi = ctx.ui;
    if (!statusEnabled || !isXaiProvider(ctx.model?.provider)) {
      clear(ctx);
      return { ok: false };
    }
    if (!hasXaiOAuth(ctx)) {
      // Keep enabled preference, but hide status until OAuth is available.
      clear(ctx);
      return { ok: false };
    }
    const now = dependencies.now();
    if (!force && lastRefreshAt > 0 && now - lastRefreshAt < dependencies.minimumRefreshMs) {
      return { ok: true };
    }
    if (refreshPromise) return refreshPromise;
    lastRefreshAt = now;
    const refreshGeneration = generation;
    const controller = new AbortController();
    statusController = controller;
    const pending = (async () => {
      try {
        const usage = await resolveUsage(ctx, controller.signal);
        if (
          refreshGeneration === generation
          && statusEnabled
          && isXaiProvider(ctx.model?.provider)
          && !controller.signal.aborted
        ) {
          ctx.ui.setStatus(STATUS_KEY, renderUsageStatus(usage, dependencies.now()));
        }
        return { ok: true };
      } catch (error) {
        const safeError = safeUsageError(error);
        if (refreshGeneration === generation) {
          if (safeError.code === "auth") clear(ctx);
          else clear(ctx);
        }
        return { ok: false, error: safeError };
      } finally {
        if (statusController === controller) statusController = undefined;
      }
    })();
    refreshPromise = pending;
    try {
      return await pending;
    } finally {
      if (refreshPromise === pending) refreshPromise = undefined;
    }
  };

  pi.registerCommand("grok-usage", {
    description: "Show xAI SuperGrok usage or manage the status-line indicator",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean).map((part) => part.toLowerCase());
      if (parts.length === 0) {
        oneShotController?.abort();
        const controller = new AbortController();
        oneShotController = controller;
        const requestGeneration = ++oneShotGeneration;
        const sessionGeneration = generation;
        const forwardAbort = () => controller.abort();
        ctx.signal?.addEventListener("abort", forwardAbort, { once: true });
        if (ctx.signal?.aborted) controller.abort();
        try {
          const usage = await resolveUsage(ctx, controller.signal);
          if (requestGeneration === oneShotGeneration && sessionGeneration === generation) {
            ctx.ui.notify(renderUsage(usage), "info");
            if (statusEnabled && isXaiProvider(ctx.model?.provider)) {
              ctx.ui.setStatus(STATUS_KEY, renderUsageStatus(usage, dependencies.now()));
              lastRefreshAt = dependencies.now();
            }
          }
        } catch (error) {
          if (requestGeneration === oneShotGeneration && sessionGeneration === generation) {
            ctx.ui.notify(safeUsageError(error).message, "error");
          }
        } finally {
          ctx.signal?.removeEventListener("abort", forwardAbort);
          if (oneShotController === controller) oneShotController = undefined;
        }
        return;
      }
      if (
        parts[0] !== "status"
        || parts.length > 2
        || (parts[1] && !["on", "off"].includes(parts[1]))
      ) {
        ctx.ui.notify(COMMAND_HELP, "error");
        return;
      }
      if (!parts[1]) {
        ctx.ui.notify(`Grok usage status is ${statusEnabled ? "on" : "off"}.`, "info");
        return;
      }
      if (parts[1] === "off") {
        reset(ctx, false);
        ctx.ui.notify("Grok usage status is off.", "info");
        return;
      }
      statusEnabled = true;
      lastRefreshAt = 0;
      if (!isXaiProvider(ctx.model?.provider)) {
        clear(ctx);
        ctx.ui.notify(
          "Grok usage status is on. Select an xAI/Grok model to show the status line.",
          "info",
        );
        return;
      }
      const result = await updateStatus(ctx, true);
      if (result.ok) {
        ctx.ui.notify("Grok usage status is on.", "info");
      } else {
        ctx.ui.notify(
          result.error?.message ?? "Grok usage status could not be refreshed.",
          "error",
        );
      }
    },
  });

  return {
    reset: (ctx) => reset(ctx, false),
    async syncForModel(ctx) {
      if (!statusEnabled) {
        clear(ctx);
        return;
      }
      if (!isXaiProvider(ctx.model?.provider)) {
        clear(ctx);
        return;
      }
      lastRefreshAt = 0;
      await updateStatus(ctx, true);
    },
    async refreshStatus(ctx) {
      if (!statusEnabled) return;
      await updateStatus(ctx, false);
    },
  };
}
