**🌐 语言：[English](README.md) | [中文](README.zh.md)**

# searxng-search

> 本地 SearXNG 双实例联网搜索 + 网页抓取技能。

---

## 这是什么

一个开箱即用的技能包，为 AI 代理提供两项能力：

1. **联网搜索** —— 并发查询两个本地 SearXNG 实例（Google CSE + cn.bing），按权重轮询合并（Google 13 : Bing 7）、URL 去重，返回结构化 JSON，带 10 分钟缓存。
2. **网页抓取** —— 抓取任意网址并转为 Markdown / 纯文本 / 原始 HTML（基于 turndown，与 opencode 的 webfetch 同一套转换方案），5 MB 响应上限，支持代理环境变量。

**为什么双实例？** 不把宝押在单一引擎上：一个实例挂了，另一个照样出结果。Google CSE 结果更精准；cn.bing 无需代理即可用。

---

## 架构

| 实例 | 端口 | 引擎 | 网络路径 |
|---|---|---|---|
| `searxng` | `http://127.0.0.1:8888` | Google CSE | 走 Clash 代理 `host.docker.internal:7897` |
| `searxng-direct` | `http://127.0.0.1:8889` | Bing（`cn.bing.com`） | 直连，无代理 |

- 两个容器都必须处于 Up 状态：`docker ps --filter name=searxng`
- 两个容器运行在宿主机上

### 文件结构

```
searxng-search/
├── SKILL.md              # 给代理的技能规范
├── README.md             # 本文档（英文）
├── README.zh.md          # 中文版
├── package.json          # 元信息（MIT 许可）
├── scripts/
│   ├── search.js         # 核心搜索逻辑
│   ├── run.ps1           # PowerShell 包装脚本（Windows）
│   ├── fetch.js          # 网页抓取：原生 fetch → curl → Jina 三级降级
│   └── fetch.ps1         # PowerShell 包装脚本（Windows）
└── node_modules/         # 内置 turndown + domino（免安装）
```

---

## 快速开始

> **Linux/macOS（无 PowerShell）：直接调用 Node 脚本即可，无需探测环境、无需阅读源码。**

```bash
cd ~/.agents/skills/searxng-search   # 或技能所在目录

# 1) 搜索（Google 13 : Bing 7 权重合并、去重、10 分钟缓存）
node scripts/search.js --query "deepseek v4" --count 8 --page 1

# 2) 抓取网页转 Markdown
node scripts/fetch.js --url "https://example.com" -f markdown

# 3) 抓取为纯文本
node scripts/fetch.js --url "https://example.com" -f text

# 4) 抓取原始 HTML
node scripts/fetch.js --url "https://example.com" -f html
```

### 参数

| 脚本 | 参数 | 含义 | 默认值 |
|---|---|---|---|
| `search.js` | `--query` / `-q` | 查询词（必填） | — |
| `search.js` | `--count` / `-n` | 结果条数 | `8` |
| `search.js` | `--page` / `-p` | 页码 | `1` |
| `fetch.js` | `--url` / `-u` | 目标网址（必填） | — |
| `fetch.js` | `--format` / `-f` | `markdown` \| `text` \| `html` | `markdown` |
| `fetch.js` | `--timeout` / `-t` | 超时秒数（上限 120） | `30` |
| `fetch.js` | `--no-fallback` | 禁用抓取降级链 | 关 |
| `fetch.js` | `--verbose` | 打印降级路径 | 关 |

**Windows / PowerShell：使用等价的包装脚本：**

```powershell
& "$env:USERPROFILE\.agents\skills\searxng-search\scripts\run.ps1" -q "deepseek v4" -n 8
& "$env:USERPROFILE\.agents\skills\searxng-search\scripts\fetch.ps1" -u "https://example.com" -f markdown
```

---

## 输出约定

### 搜索

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

- `results[]` — 跨引擎去重，上限 `-n`
- `errors[]` — 各端口失败原因（容器停止、超时…）
- `warnings[]` — 非致命提示（缓存命中、不支持翻页…）
- `cached` — 命中 10 分钟缓存时为 `true`

### 抓取

- stdout：转换后的正文——Markdown（默认）、纯文本或原始 HTML
- stderr：失败原因写 stderr，退出码 1（带有失败级标注，如 `[stage:jina]`）
- `http://` 自动升级为 `https://`
- 5 MB 响应上限

`fetch.js` 带三级降级链，攻坚站点也能抓：

```
第1级  原生 node fetch   Chrome 完整请求头 + Accept 协商 + Cloudflare 挑战换 UA 重试
         ↓ 失败 / 被拦截 / 空页
第2级  curl 走环境代理   修复 node fetch 在 socks/混合代理、TLS 指纹环境失效的问题
         ↓ 失败 / 被拦截 / 空页
第3级  Jina Reader        r.jina.ai 云端渲染——攻克知乎等强反爬站
```

每一级都做内容质量门控：403 拦截页、验证墙、空页面、base64 图片噪声一律判为失败并继续降级——绝不让拦截页冒充成功。

> **注意：** Jina 级只返回 Markdown 文本。`-f html` 若由 Jina 级服务，会输出 Markdown 并在 stderr 提示。使用 `--verbose` 可查看每个站点实际由哪一级服务；`--no-fallback` 只走第 1 级（单级抓取）。

---

## 依赖

- **Node.js ≥ 18**（使用全局 `fetch`、`AbortController`）
- **curl**（第 2 级降级依赖）
- **Docker** —— 两个 SearXNG 容器（8888 / 8889）
- 无需 npm install —— `node_modules/` 已内置
- PowerShell（仅 Windows 可选）

---

## 已知限制

- `cn.bing.com` 不支持翻页，`-p 2` 只影响 Google 结果
- 抓取缓存写入 `~/.cache/searxng-search/`（尽力而为，写失败不阻塞）
- `--no-fallback` 还原单级抓取行为
- Jina 匿名额度有限，高频使用可能触发 `AbuseAlleviationError` 限流

---

## 许可证

[MIT](LICENSE) —— 个人与商业使用均免费。

Copyright © 2026 bookmarshwar。完整条款见 [LICENSE](LICENSE) 文件。

---

*用心维护，欢迎提交 PR。*