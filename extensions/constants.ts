import packageMetadata from "../package.json";

/** Revision-pinned Grok Build billing surface (same contract as pi-xai-oauth /xai-usage). */
export const XAI_CLI_USER_URL = "https://cli-chat-proxy.grok.com/v1/user";
export const XAI_CLI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_GROK_CLI_AUTH_SCOPE_KEY = `${XAI_OAUTH_ISSUER}::${XAI_OAUTH_CLIENT_ID}`;
export const XAI_GROK_CLI_LEGACY_AUTH_SCOPE_KEY = "https://accounts.x.ai/sign-in";

export const XAI_PROVIDER_IDS = ["xai-auth", "xai"] as const;
export type XaiProviderId = (typeof XAI_PROVIDER_IDS)[number];

export const PACKAGE_NAME = packageMetadata.name;
export const PACKAGE_VERSION = packageMetadata.version;
export const USER_AGENT = `${PACKAGE_NAME}/${PACKAGE_VERSION}`;

export const USAGE_TIMEOUT_MS = 15_000;
export const USAGE_MAX_RESPONSE_BYTES = 64 * 1024;
export const USAGE_MAX_JSON_DEPTH = 12;
export const USAGE_MAX_JSON_ARRAY_ITEMS = 64;
export const USAGE_MAX_JSON_OBJECT_KEYS = 64;
export const USAGE_MAX_JSON_NODES = 2048;
export const USAGE_MAX_HISTORY_PERIODS = 24;
export const USAGE_STATUS_MIN_REFRESH_MS = 60_000;

export const STATUS_KEY = "grok-usage";
export const COMMAND_HELP = "Usage: /grok-usage [status [on|off]]";

export function isXaiProvider(provider: unknown): provider is XaiProviderId {
  return typeof provider === "string" && (XAI_PROVIDER_IDS as readonly string[]).includes(provider);
}
