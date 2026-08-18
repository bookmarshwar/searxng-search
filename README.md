# searxng-search

> Local SearXNG dual-instance web search & page fetch — a reusable agent skill.
>
> 本地 SearXNG 双实例联网搜索 + 网页抓取技能。

---

## What is this? / 这是什么

A self-contained skill that gives an AI agent two capabilities:

1. **Web search** — queries two local SearXNG instances concurrently (Google CSE + cn.bing), merges results by weighted round-robin (Google 13 : Bing 7), deduplicates URLs, and returns structured JSON with a 10-minute cache.
2. **Page fetch** — downloads any URL and converts it to Markdown / plain text / raw HTML (turndown-based, same conversion approach as opencode's webfetch), with a 5 MB response cap and proxy support.

一个开箱即用的技能包，为 AI 代理提供两项能力：

1. **联网搜索** —— 并发查询两个本地 SearXNG 实例（Google CSE + cn.bing），按权重轮询合并（Google 13 : Bing 7）、URL 去重，返回结构化 JSON，带 10 分钟缓存。
2. **网页抓取** —— 抓取任意网址并转为 Markdown / 纯文本 / 原始 HTML（基于 turndown，与 opencode 的 webfetch 同一套转换方案），5 MB 响应上限，支持代理环境变量。

**Why dual instances?** Never block on a single engine: if one instance fails, the other still returns results. Google CSE is more precise; cn.bing works without a proxy.

**为什么双实例？** 不把宝押在单一引擎上：一个实例挂了，另一个照样出结果。Google CSE 结果更精准；cn.bing 无需代理即可用。

---

## Architecture / 架构

| Instance / 实例 | Port / 端口 | Engine / 引擎 | Network path / 网络路径 |
|---|---|---|---|
| `searxng` | `http://127.0.0.1:8888` | Google CSE | via Clash proxy `host.docker.internal:7897` |
| `searxng-direct` | `http://127.0.0.1:8889` | Bing (`cn.bing.com`) | direct, no proxy |

- Both containers must be `Up`: `docker ps --filter name=searxng`
- Both containers run on the host: `docker ps` 确认 `searxng` 与 `searxng-direct` 处于 Up 状态

### Files / 文件结构

```
searxng-search/
├── SKILL.md              # Skill spec for the agent · 给代理的技能规范
├── README.md             # This document · 本文档
├── package.json          # Metadata (MIT license) · 元信息（MIT 许可）
├── scripts/
│   ├── search.js         # Core search logic · 核心搜索逻辑
│   ├── run.ps1           # PowerShell wrapper (Windows) · Windows 包装脚本
│   ├── fetch.js          # Page fetch: native fetch → curl → Jina fallback · 网页抓取（三级降级）
│   └── fetch.ps1         # PowerShell wrapper (Windows) · Windows 包装脚本
└── node_modules/         # Bundled turndown + domino (no install needed) · 内置依赖，免安装
```

---

## Quick Start / 快速开始

> **Linux / macOS (no PowerShell): call the Node scripts directly — no probing, no reading source.**
> **Linux/macOS（无 PowerShell）：直接调用 Node 脚本即可，无需探测环境、无需阅读源码。**

```bash
cd ~/.agents/skills/searxng-search   # or wherever this skill lives / 或技能所在目录

# 1) Search / 搜索 (Google 13 : Bing 7 weighted merge, dedup, 10-min cache)
node scripts/search.js --query "deepseek v4" --count 8 --page 1

# 2) Fetch a page as Markdown / 抓取网页转 Markdown
node scripts/fetch.js --url "https://example.com" -f markdown

# 3) Fetch as plain text / 抓取为纯文本
node scripts/fetch.js --url "https://example.com" -f text

# 4) Fetch raw HTML / 抓取原始 HTML
node scripts/fetch.js --url "https://example.com" -f html
```

### Arguments / 参数

| Script / 脚本 | Flag / 参数 | Meaning / 含义 | Default / 默认值 |
|---|---|---|---|
| `search.js` | `--query` / `-q` | Search query (required) · 查询词（必填） | — |
| `search.js` | `--count` / `-n` | Result count · 结果条数 | `8` |
| `search.js` | `--page` / `-p` | Page number · 页码 | `1` |
| `fetch.js` | `--url` / `-u` | Target URL (required) · 目标网址（必填） | — |
| `fetch.js` | `--format` / `-f` | `markdown` \| `text` \| `html` · 输出格式 | `markdown` |
| `fetch.js` | `--timeout` / `-t` | Timeout in seconds (max 120) · 超时秒数（上限 120） | `30` |
| `fetch.js` | `--no-fallback` | Disable fetch fallback chain · 禁用抓取降级链 | off |
| `fetch.js` | `--verbose` | Show each fallback stage · 打印降级路径 | off |

**Windows / PowerShell:** use the equivalent wrappers / 使用等价包装脚本：

```powershell
& "$env:USERPROFILE\.agents\skills\searxng-search\scripts\run.ps1" -q "deepseek v4" -n 8
& "$env:USERPROFILE\.agents\skills\searxng-search\scripts\fetch.ps1" -u "https://example.com" -f markdown
```

---

## Output Contract / 输出约定

### Search / 搜索

Single JSON document on stdout. Exit code: `0` = results, `1` = none.
stdout 输出单个 JSON 文档；退出码 `0` = 有结果，`1` = 无结果。

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

- `results[]` — deduplicated by URL across both engines, capped at `-n` · 跨引擎去重，上限 `-n`
- `errors[]` — per-port failure reasons (container stopped, timeout…) · 各端口失败原因
- `warnings[]` — non-fatal notes (cache hit, paging unsupported…) · 非致命提示
- `cached` — `true` when served from the 10-minute query+page cache · 命中 10 分钟缓存时为 `true`

### Fetch / 抓取

- stdout: converted content — Markdown (default), plain text, or raw HTML · 转换后的正文
- stderr: failure reason on exit 1 · 失败原因写 stderr，退出码 1
- `http://` URLs are auto-upgraded to `https://` · `http://` 自动升级为 `https://`
- 5 MB response cap · 5 MB 响应上限

`fetch.js` has a 3-stage fallback chain so hard sites still work:

`fetch.js` 带三级降级链，攻坚站点也能抓：

```
stage 1  native node fetch   Chrome headers + Accept negotiation + Cloudflare-challenge UA retry
         ↓ fail / blocked / empty
stage 2  curl via env proxy  works where node fetch breaks (socks/mixed proxy, TLS fingerprinting)
         ↓ fail / blocked / empty
stage 3  Jina Reader         r.jina.ai cloud render — crosses strong anti-bot walls (zhihu, etc.)
```

Each stage runs a content-quality check: 403 / block pages, JS-challenge walls, empty bodies and
base64-image spam are treated as failure — no false "success" from a block page.
每一级都做内容质量门控：403 拦截页、验证墙、空页面、base64 图片噪声一律判为失败并继续降级——绝不让拦截页冒充成功。

---

## Dependencies / 依赖

- **Node.js ≥ 18** (uses global `fetch`, `AbortController`) · 需要 Node.js ≥ 18
- **curl** (for fallback stage 2) · 第二级降级依赖 curl
- **Docker** — two SearXNG containers on ports 8888 / 8889 · 两个 SearXNG 容器（8888 / 8889）
- No npm install needed — `node_modules/` is bundled · 免安装依赖，`node_modules/` 已内置
- PowerShell (Windows only, optional) · PowerShell 仅 Windows 可选

---

## Known Limits / 已知限制

- `cn.bing.com` does not support pagination; `-p 2` changes Google results only · Bing 不支持翻页，`-p 2` 只影响 Google 结果
- Fetch cache writes to `~/.cache/searxng-search/`（best-effort，写失败不阻塞）· 抓取缓存为尽力而为
- `--no-fallback` reproduces the original single-stage fetch behavior · `--no-fallback` 还原单级抓取行为
- Jina Reader has anonymous rate limits — heavy use may hit `AbuseAlleviationError` · Jina 匿名额度有限，高频使用可能触发限流

---

## License / 许可证

[MIT](LICENSE) — free for personal and commercial use.

[MIT](LICENSE) — 个人与商业使用均免费。

Copyright © 2026 bookmarshwar. See [LICENSE](LICENSE) for the full text.

---

*Maintained with ❤️ and a local SearXNG. PRs welcome. / 欢迎提交 PR。*