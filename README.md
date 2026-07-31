# pi-grok-usage

A [Pi](https://pi.dev/) extension that shows your xAI SuperGrok / X Premium subscription usage in the footer status line.

```text
AM● a:0 d:0 Grok 56.7% (7/20 14:00)
```

Requires an xAI **OAuth** session (`/login xai`, `pi-xai-oauth` `/login xai-auth`, or `~/.grok/auth.json`). API keys are not supported.

## Installing

```bash
pi install npm:pi-grok-usage
```

Or from git:

```bash
pi install git:github.com/puetsua/pi-grok-usage
```

## Commands

Status is **on by default** for active `xai` / `xai-auth` models.

- `/grok-usage` — one-shot full usage report
- `/grok-usage status` — show on/off
- `/grok-usage status on|off` — enable or disable the footer status

Refreshes after turns (at most once per minute). Clears when you leave an xAI model.

## Releasing

Push a bare semver tag (no `v` prefix). GitHub Actions publishes to npm via OIDC (`environment: npm`) and opens a GitHub Release:

```bash
git tag 1.0.1
git push origin 1.0.1
```

## License

MIT

