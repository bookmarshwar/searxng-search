---
name: searxng-search
description: >-
  Search the web via local SearXNG dual instances: google cse on :8888 (via Clash proxy
  127.0.0.1:7897) and cn.bing.com on :8889 (direct, no proxy). Node-based, call directly:
  node scripts/search.js --query <q> --count <n> --page <p>; also fetch a URL as markdown:
  node scripts/fetch.js --url <u> [-f markdown|text|html] (turndown-based, honors proxies).
  Returns structured JSON; exit code 0 = results, 1 = none. PowerShell wrappers
  (run.ps1/fetch.ps1) are Windows-only equivalents.
  通过本地 SearXNG 双实例搜索（8888 google cse 走 Clash 代理 / 8889 cn.bing 直连）。直接调用：
  node scripts/search.js --query <查询词> -n 条数(默认8) -p 页码(默认1)，抓网页
  node scripts/fetch.js --url <网址> [-f markdown|text|html]。输出结构化 JSON，
  退出码 0=有结果，1=无结果。适用于需要联网检索、查资料、验证信息、中英文搜索的场景。
---

# SearXNG Search Skill

Search the web using two local SearXNG containers. Never blocks on one engine:
if one instance fails, the other still returns results. Also fetches web pages
as Markdown (HTML->Markdown via the same turndown library opencode's webfetch uses).

## Architecture

| Instance | Port | Engine | Network path |
|---|---|---|---|
| `searxng` | `http://127.0.0.1:8888` | google cse | via Clash proxy `host.docker.internal:7897` (must be running) |
| `searxng-direct` | `http://127.0.0.1:8889` | bing (`cn.bing.com`) | direct, no proxy (works with Clash on or off) |

- Both containers must be `Up`: `docker ps --filter name=searxng`
- Settings files live in `E:\AI\DSH\searxng-docker-settings*.yml`
  (copy into container volume + `docker restart searxng` to apply)
- Skill scripts live in this directory. A distributable backup for installing
  this skill elsewhere is at `E:\AI\DSH\ARCHIVE\searxng-search-skill\`

## Usage

> **直接调用（默认，Linux/macOS 无 PowerShell 时就是用这个）：** 不用看脚本源码，
> 不用探测环境，直接在技能目录下运行下面的 node 命令即可：
>
> ```bash
> cd ~/.agents/skills/searxng-search
> node scripts/search.js --query "deepseek v4" --count 8 --page 1   # 搜索
> node scripts/fetch.js --url "https://example.com" -f markdown     # 抓网页转 Markdown
> ```
>
> - `search.js` 参数：`--query/-q` 查询词(必填)，`--count/-n` 条数(默认8)，`--page/-p` 页码(默认1)
> - `fetch.js` 参数：`--url/-u` 网址(必填)，`-f markdown|text|html`(默认 markdown)，`-t` 超时秒(默认30)
> - 若技能目录不在 `~/.agents/skills/searxng-search`，先 `find` 定位含 `scripts/search.js` 的目录再 `cd`。

**Windows / 有 PowerShell 时，才用等价的 ps1 包装脚本：**

```powershell
# Basic search (returns top 8 results, google 13 : bing 7 weighted mix)
& "$env:USERPROFILE\.agents\skills\searxng-search\scripts\run.ps1" -q "deepseek v4" -n 8

# Page 2 (google honors pageno; bing/cn.bing.com does not support paging)
& "$env:USERPROFILE\.agents\skills\searxng-search\scripts\run.ps1" -q "wsl proxy" -p 2

# Fetch a page as Markdown (same turndown conversion opencode's webfetch uses)
& "$env:USERPROFILE\.agents\skills\searxng-search\scripts\fetch.ps1" -u "https://www.mcmod.cn/item/62406.html"

# Fetch as plain text or raw html
& "$env:USERPROFILE\.agents\skills\searxng-search\scripts\fetch.ps1" -u "https://example.com" -f text
```

## Fetch details

- Output: the page converted to Markdown (default), plain text (`-f text`), or raw HTML (`-f html`).
- `http://` URLs are auto-upgraded to `https://`.
- Honors `http_proxy`/`https_proxy` env vars (e.g. `http://127.0.0.1:7897` for Clash);
  restricted/blocked sites need the proxy, domestic sites work direct.
- 5 MB response cap; default timeout 30s (`-t <seconds>`, max 120).
- Chrome user-agent; retries once with UA `opencode` on Cloudflare 403 challenges.
- Exit code: `0` = success, `1` = failure (message on stderr).

## Output contract

Single JSON document on stdout:

```json
{
  "query": "deepseek v4",
  "pageno": 1,
  "count": 12,
  "cached": false,
  "results": [
    { "title": "...", "url": "https://...", "snippet": "...", "engine": "google cse", "port": 8888 }
  ],
  "errors": [ { "port": 8888, "error": "fetch failed: connect ECONNREFUSED ..." } ],
  "warnings": [ "bing does not support paging; results are page 1" ]
}
```

- `results[]`: deduplicated by URL across both instances, capped at `-n`
- `errors[]`: per-port failure reasons (Clash down, container stopped, timeout...)
- `warnings[]`: non-fatal notes (cache hit, paging unsupported, ...)
- `cached`: true when served from the 10-minute query+pageno cache
- Exit code: `0` = at least one result; `1` = zero results overall or fatal failure

## Behaviors & known limits

- Cache TTL 10 minutes per `query+pageno`; repeat queries report `cached: true`.
  Change the query wording or wait to force a fresh search.
- `cn.bing.com` does not support pagination; `-p 2` changes google results only.
- Port 8889 fixes `language=zh-CN` (mkt=zh-CN) because cn.bing.com without a region
  returns unrelated hot recommendations instead of matching results.
- bing may still return unrelated fallback/recommendation results for queries with no
  real matches (cn.bing.com upstream behavior); google cse is usually more precise.
- If google results are empty, first check Clash is listening on `127.0.0.1:7897`
  (the container reaches it via `host.docker.internal`), then check container logs:
  `docker logs searxng --tail 50`

## Troubleshooting

| Symptom | Action |
|---|---|
| `errors` contains port 8888 connection refused | `docker ps`; is `searxng` Up? |
| 8888 timeouts / google empty | Is Clash running? `Get-NetTCPConnection -LocalPort 7897 -State Listen` |
| 8889 empty / bing errors | `docker logs searxng-direct --tail 50`; bing is rate-sensitive, retry later |
| fetch fails `ECONNREFUSED 127.0.0.1:7897` | Proxy env points at Clash but Clash is stopped — start it or unset the proxy vars |
| fetch can't reach blocked site | Set `$env:https_proxy = "http://127.0.0.1:7897"` (Clash) and retry |
| Script not found | Restore from `E:\AI\DSH\ARCHIVE\searxng-search-skill\` (copy to `~\.agents\skills\`) — includes `node_modules` |

## Files

- `scripts/run.ps1` — search entry point (`-q` required, `-n` default 8, `-p` default 1)
- `scripts/search.js` — node query logic: concurrent dual-port fetch, weighted merge (google 13 : bing 7), URL dedup, 10-min cache
- `scripts/fetch.ps1` — URL fetch entry point (`-u` required, `-f` markdown|text|html, `-t` timeout)
- `scripts/fetch.js` — node fetch: turndown HTML->Markdown, env proxy, 5MB cap, Cloudflare-challenge retry
- `node_modules/` — bundled `turndown` + `domino` (used by fetch.js)
