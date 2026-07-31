import { describe, expect, it } from "vitest";
import {
  effectivePercent,
  parseUsage,
  parseUserId,
  remainingPercent,
  renderUsage,
  renderUsageStatus,
  UsageError,
} from "../extensions/usage";
import creditsNew from "./fixtures/credits-new.json";

describe("parseUserId", () => {
  it("accepts a printable userId", () => {
    expect(parseUserId({ userId: "user-fixture-82" })).toBe("user-fixture-82");
  });

  it("rejects missing or invalid identity", () => {
    expect(() => parseUserId({})).toThrow(UsageError);
    expect(() => parseUserId({ userId: "bad id" })).toThrow(UsageError);
  });
});

describe("parseUsage", () => {
  it("parses the modern credits payload", () => {
    const usage = parseUsage(creditsNew);
    expect(usage.subscriptionTier).toBe("SuperGrok");
    expect(usage.creditUsagePercent).toBe(42.5);
    expect(usage.onDemandCapCents).toBe(5000);
    expect(usage.onDemandUsedCents).toBe(300);
    expect(usage.prepaidBalanceCents).toBe(1250);
    expect(usage.isUnifiedBillingUser).toBe(true);
    expect(usage.history).toHaveLength(1);
    expect(usage.currentPeriod?.end).toBe("2026-07-20T00:00:00Z");
  });

  it("derives percent from legacy used/limit cents", () => {
    const usage = parseUsage({
      config: {
        used: { val: 2500 },
        monthlyLimit: { val: 10000 },
      },
    });
    expect(effectivePercent(usage)).toBe(25);
    expect(remainingPercent(usage)).toBe(75);
  });
});

describe("renderUsageStatus", () => {
  it("shows remaining percent and local reset M/D HH:mm", () => {
    const usage = parseUsage(creditsNew);
    // 42.5% used → 57.5% remaining; period ends 2026-07-20T00:00:00Z
    const text = renderUsageStatus(usage, Date.parse("2026-07-17T00:00:00Z"));
    const local = new Date("2026-07-20T00:00:00Z");
    const expectedWhen = `${local.getMonth() + 1}/${local.getDate()} ${local
      .getHours()
      .toString()
      .padStart(2, "0")}:${local.getMinutes().toString().padStart(2, "0")}`;
    expect(text).toBe(`SuperGrok 57.5% (${expectedWhen})`);
  });

  it("falls back when only prepaid is present", () => {
    const text = renderUsageStatus(
      { history: [], prepaidBalanceCents: 999 },
      Date.now(),
    );
    expect(text).toBe("SuperGrok $9.99");
  });
});

describe("renderUsage", () => {
  it("includes remaining and readable local timestamps", () => {
    const text = renderUsage(parseUsage(creditsNew));
    expect(text).toContain("Grok usage:");
    expect(text).not.toContain("unofficial");
    expect(text).not.toMatch(/Period start: \d{4}-\d{2}-\d{2}T/);
    expect(text).not.toMatch(/Reset: \d{4}-\d{2}-\d{2}T/);
    expect(text).toMatch(/Period start: /);
    expect(text).toMatch(/Reset: /);
    expect(text).toContain("Included usage: 42.5% used");
    expect(text).toContain("Included remaining: 57.5%");
    expect(text).toContain("Subscription: SuperGrok");
    expect(text).toContain("On-demand credits: $3.00 used of $50.00");
  });
});
