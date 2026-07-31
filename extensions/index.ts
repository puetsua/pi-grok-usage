import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerUsage } from "./usage";

/**
 * Shows xAI SuperGrok subscription usage in the Pi status line.
 *
 * Billing lookup matches the revision-pinned unofficial surface used by
 * pi-xai-oauth `/xai-usage`: authenticated GET /v1/user then GET /v1/billing?format=credits.
 *
 * Status is on by default for xAI OAuth sessions. Control with:
 *   /grok-usage
 *   /grok-usage status on|off
 */
export default function (pi: ExtensionAPI) {
  const usage = registerUsage(pi);

  pi.on("session_start", (_event, ctx) => {
    // Footer is cosmetic — never block session startup.
    void usage.syncForModel(ctx).catch(() => undefined);
  });

  pi.on("model_select", (_event, ctx) => {
    void usage.syncForModel(ctx).catch(() => undefined);
  });

  pi.on("turn_end", (_event, ctx) => {
    // Refresh after completed turns, rate-limited inside the feature.
    void usage.refreshStatus(ctx).catch(() => undefined);
  });

  pi.on("agent_settled", (_event, ctx) => {
    void usage.refreshStatus(ctx).catch(() => undefined);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    usage.reset(ctx);
  });
}
