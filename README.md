# pi-grok-usage

A [Pi](https://pi.dev/) extension that shows your xAI SuperGrok / X Premium subscription usage in the footer status line.

```text
SuperGrok 56.7% (7/20 14:00)
```

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

## License

MIT

