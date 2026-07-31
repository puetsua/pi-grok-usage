# pi-grok-usage

[![npm version](https://img.shields.io/npm/v/pi-grok-usage)](https://www.npmjs.com/package/pi-grok-usage)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Pi coding-agent extension** that shows your **xAI SuperGrok / X Premium** subscription usage in the footer status line.

```text
Grok 57.5% left · 3d 12h
```

## Install

```bash
pi install npm:pi-grok-usage
```

Or from git:

```bash
pi install git:github.com/puetsua/pi-grok-usage
```

Local checkout:

```bash
pi install .
```

## Requirements

- [Pi](https://pi.dev) coding agent
- An **xAI OAuth** session (not an API key):
  - built-in `/login xai` (SuperGrok / X Premium), or
  - [`pi-xai-oauth`](https://pi.dev/packages/pi-xai-oauth) `/login xai-auth`, or
  - official Grok CLI credentials at `~/.grok/auth.json`

API-key-only xAI accounts are **not** supported for this billing surface.

## Usage

Status is **on by default** when an `xai` / `xai-auth` model is active and OAuth is available.

| Command | Effect |
| --- | --- |
| `/grok-usage` | One-shot full usage report (toast) |
| `/grok-usage status` | Show whether the footer status is on/off |
| `/grok-usage status on` | Enable footer status + refresh now |
| `/grok-usage status off` | Disable and clear footer status |

### Status line behavior

- Shows **remaining** included allowance (`% left`) when available, plus time until period reset
- Refreshes after completed turns / agent settle, **at most once per minute**
- Clears automatically when you leave an xAI model
- Failures clear the status silently and never block chat

### How it gets usage

Same unofficial, revision-pinned billing path documented by `pi-xai-oauth` `/xai-usage` (Grok Build billing surface):

1. Authenticated `GET https://cli-chat-proxy.grok.com/v1/user`
2. Use the returned `userId` only for the next request
3. Authenticated `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`
4. Discard identity; display only validated fields

This is **not** a stable public xAI API. Requests reject redirects, use a 15s timeout, read at most 64 KiB, and never log tokens, raw bodies, or account identity.

Web UI reference: [grok.com usage](https://grok.com/?_s=usage)

## Package layout

```text
extensions/
  index.ts       # Pi extension entry (events + registerUsage)
  usage.ts       # fetch / parse / render / /grok-usage command
  auth.ts        # OAuth credential resolution
  constants.ts
```

## Development

```bash
npm install
npm test
npm run typecheck
pi install .
```

## Related

- [pi-xai-oauth](https://pi.dev/packages/pi-xai-oauth) — OAuth provider + `/xai-usage`
- [Pi packages](https://pi.dev/docs/latest/packages)
- [Pi extensions](https://pi.dev/docs/latest/extensions)

## License

MIT
