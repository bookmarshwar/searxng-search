**🌐 Language: [English](README.md) | [中文](README.zh.md)**

# searxng-search

> Local SearXNG dual-instance web search & page fetch — a reusable agent skill.

---

## What is this?

A self-contained skill that gives an AI agent two capabilities:

1. **Web search** — queries two local SearXNG instances concurrently (Google CSE + cn.bing), merges results by weighted round-robin (Google 13 : Bing 7), deduplicates URLs, and returns structured JSON with a 10-minute cache.
2. **Page fetch** — downloads any URL and converts it to Markdown / plain text / raw HTML (turndown-based, same conversion approach as opencode's webfetch), with a 5 MB response cap and proxy support.

**Why dual instances?** Never block on a single engine: if one instance fails, the other still returns results. Google CSE is more precise; cn.bing works without a proxy.

---

## Architecture

| Instance | Port | Engine | Network path |
|---|---|---|---|
| `searxng` | `http://127.0.0.1:8888` | Google CSE | via Clash proxy `host.docker.internal:7897` |
| `searxng-direct` | `http://127.0.0.1:8889` | Bing (`cn.bing.com`) | direct, no proxy |

- Both containers must be `Up`: `docker ps --filter name=searxng`
- Both containers run on the host machine

### Files

```
searxng-search/
├── SKILL.md              # Skill spec for the agent
├── README.md             # This document (English)
├── README.zh.md          # Chinese translation
├── package.json          # Metadata (MIT license)
├── scripts/
│   ├── search.js         # Core search logic
│   ├── run.ps1           # PowerShell wrapper (Windows)
│   ├── fetch.js          # Page fetch: native fetch → curl → Jina fallback
│   └── fetch.ps1         # PowerShell wrapper (Windows)
└── node_modules/         # Bundled turndown + domino (no install needed)
```

---

## Quick Start

> **Linux / macOS (no PowerShell): call the Node scripts directly — no probing, no reading source.**

```bash
cd ~/.agents/skills/searxng-search   # or wherever this skill lives

# 1) Search (Google 13 : Bing 7 weighted merge, dedup, 10-min cache)
node scripts/search.js --query "deepseek v4" --count 8 --page 1

# 2) Fetch a page as Markdown
node scripts/fetch.js --url "https://example.com" -f markdown

# 3) Fetch as plain text
node scripts/fetch.js --url "https://example.com" -f text

# 4) Fetch raw HTML
node scripts/fetch.js --url "https://example.com" -f html
```

### Arguments

| Script | Flag | Meaning | Default |
|---|---|---|---|
| `search.js` | `--query` / `-q` | Search query (required) | — |
| `search.js` | `--count` / `-n` | Result count | `8` |
| `search.js` | `--page` / `-p` | Page number | `1` |
| `fetch.js` | `--url` / `-u` | Target URL (required) | — |
| `fetch.js` | `--format` / `-f` | `markdown` \| `text` \| `html` | `markdown` |
| `fetch.js` | `--timeout` / `-t` | Timeout in seconds (max 120) | `30` |
| `fetch.js` | `--no-fallback` | Disable fetch fallback chain | off |
| `fetch.js` | `--verbose` | Show each fallback stage | off |

**Windows / PowerShell:** use the equivalent wrappers:

```powershell
& "$env:USERPROFILE\.agents\skills\searxng-search\scripts\run.ps1" -q "deepseek v4" -n 8
& "$env:USERPROFILE\.agents\skills\searxng-search\scripts\fetch.ps1" -u "https://example.com" -f markdown
```

---

## Output Contract

### Search

Single JSON document on stdout. Exit code: `0` = results, `1` = none.

```json
{
  "query": "deepseek v4",
  "pageno": 1,
  "count": 12,
  "cached": false,
  "results": [
    {
      "title": "DeepSeek | Into the Unknown",
      "url": "https://www.deepseek.com/",
      "snippet": "",
      "engine": "google cse",
      "port": 8888
    }
  ],
  "errors": [],
  "warnings": []
}
```

- `results[]` — deduplicated by URL across both engines, capped at `-n`
- `errors[]` — per-port failure reasons (container stopped, timeout…)
- `warnings[]` — non-fatal notes (cache hit, paging unsupported…)
- `cached` — `true` when served from the 10-minute query+page cache

### Fetch

- stdout: converted content — Markdown (default), plain text, or raw HTML
- stderr: failure reason on exit 1 (tagged with the failing stage, e.g. `[stage:jina]`)
- `http://` URLs are auto-upgraded to `https://`
- 5 MB response cap

`fetch.js` has a 3-stage fallback chain so hard sites still work:

```
stage 1  native node fetch   Chrome headers + Accept negotiation + Cloudflare-challenge UA retry
         ↓ fail / blocked / empty
stage 2  curl via env proxy  works where node fetch breaks (socks/mixed proxy, TLS fingerprinting)
         ↓ fail / blocked / empty
stage 3  Jina Reader         r.jina.ai cloud render — crosses strong anti-bot walls (zhihu, etc.)
```

Each stage runs a content-quality check: 403 / block pages, JS-challenge walls, empty bodies and
base64-image spam are treated as failure — no false "success" from a block page.

> **Note:** The Jina stage only returns Markdown text. If `-f html` is served by the Jina stage,
> it outputs Markdown instead and notes it on stderr. Use `--verbose` to see which stage served
> each page; `--no-fallback` limits to stage 1 only (single-stage fetch).

---

## Dependencies

- **Node.js ≥ 18** (uses global `fetch`, `AbortController`)
- **curl** (for fallback stage 2)
- **Docker** — two SearXNG containers on ports 8888 / 8889
- No npm install needed — `node_modules/` is bundled
- PowerShell (Windows only, optional)

---

## Known Limits

- `cn.bing.com` does not support pagination; `-p 2` changes Google results only
- Fetch cache writes to `~/.cache/searxng-search/` (best-effort, write failure is non-blocking)
- `--no-fallback` reproduces the original single-stage fetch behavior
- Jina Reader has anonymous rate limits — heavy use may hit `AbuseAlleviationError`

---

## License

[MIT](LICENSE) — free for personal and commercial use.

Copyright © 2026 bookmarshwar. See [LICENSE](LICENSE) for the full text.

---

*Maintained with ❤️ and a local SearXNG. PRs welcome.*