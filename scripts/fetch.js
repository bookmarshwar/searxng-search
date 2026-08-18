#!/usr/bin/env node
/**
 * fetch.js — 增强版多级降级网页抓取 (searxng-search-fork-fetch)
 *
 * 基于 searxng-search 原版 fetch.js 改造, 通过 3 级降级链解决原版
 * "部分网站访问不了" 的问题 (实测: HN / GitHub / 知乎 / Reddit / Cloudflare 挑战站):
 *
 *   1. 原生 node fetch    — Chrome 完整 headers + Accept 协商 + CF 挑战换 UA 重试
 *   2. curl 代理回退      — node fetch 不认 socks/混合代理时, 用 curl 走环境代理重试
 *   3. Jina Reader 服务   — 云端渲染/抓取, 能破知乎/Reddit 等强反爬站 (r.jina.ai)
 *
 * 每级之间做"内容质量检查": 404/403 拦截页/验证页/空页 → 判定该级无效, 继续降级。
 *
 * 用法:
 *   node scripts/fetch.js --url <http(s)://...> [-f markdown|text|html] [-t 秒] [--no-fallback] [--verbose]
 *
 *   -f/--format   输出格式: markdown(默认) | text | html
 *   -t/--timeout  超时秒数(默认30, 上限120)
 *   --no-fallback 禁用降级链(只试原生 fetch, 等同原版行为)
 *   --verbose     打印每级降级路径到 stderr
 *
 * 输出: 成功 → 正文写到 stdout, exit 0; 失败 → 原因写 stderr (含 [stage] 标注), exit 1.
 */
'use strict';

const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TurndownService = require(path.join(__dirname, '..', 'node_modules', 'turndown'));

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5 MB
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const MAX_TIMEOUT_MS = 120 * 1000;

// honor http_proxy/https_proxy env vars (e.g. Clash at 127.0.0.1:7897)
try {
    http.setGlobalProxyFromEnv();
} catch {
    // proxy support unavailable on this node; continue direct
}

function convertHTMLToMarkdown(html) {
    const turndownService = new TurndownService({
        headingStyle: 'atx',
        hr: '---',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced',
        emDelimiter: '*',
    });
    turndownService.remove(['script', 'style', 'meta', 'link']);
    return turndownService.turndown(html);
}

function extractTextFromHTML(html) {
    const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
        .replace(/<object[\s\S]*?<\/object>/gi, '')
        .replace(/<embed[\s\S]*?<\/embed>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n/g, '\n')
        .trim();
    return text;
}

function fetchWithTimeout(url, headers, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
    return fetch(url, { signal: controller.signal, headers })
        .finally(() => clearTimeout(timer));
}

/** 第一级: 原生 node fetch + CF 挑战重试 — 返回 {buf, contentType} 结构契约 */
async function stageFetch(url, headers, ms) {
    let res = await fetchWithTimeout(url, headers, ms);
    if (res.status === 403 && res.headers.get('cf-mitigated') === 'challenge') {
        // Cloudflare challenge: retry once with the opencode UA, like opencode does
        res = await fetchWithTimeout(url, { ...headers, 'User-Agent': 'opencode' }, ms);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, buf, contentType: res.headers.get('content-type') || '' };
}

/** 第二级: curl 走环境代理 (node fetch 不认 socks 的兜底) */
function stageCurl(url, headers, ms) {
    const hdr = Object.entries(headers).map(([k, v]) => ['-H', `${k}: ${v}`]).flat();
    const args = ['-sSL', '--max-time', String(Math.ceil(ms / 1000)), ...hdr, url];
    const buf = execFileSync('curl', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: null,
        maxBuffer: MAX_RESPONSE_SIZE + 1024 * 1024,
    });
    return { ok: true, buf, contentType: 'text/html; charset=utf-8' };
}

/** 第三级: Jina Reader (r.jina.ai) 破强反爬站 — 用 curl 走代理抓取 */
function stageJina(url, ms) {
    const jinaUrl = 'https://r.jina.ai/' + url;
    const args = ['-sSL', '--max-time', String(Math.ceil(ms / 1000)),
        '-H', 'User-Agent: Mozilla/5.0',
        '-H', 'Accept: text/markdown',
        '-H', 'X-Return-Format: markdown',
        jinaUrl];
    let buf;
    try {
        buf = execFileSync('curl', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: null,
            maxBuffer: MAX_RESPONSE_SIZE + 1024 * 1024,
        });
    } catch (e) {
        const errText = e.stderr ? e.stderr.toString().slice(0, 200) : '';
        const outText = e.stdout ? e.stdout.toString().slice(0, 200) : '';
        throw new Error(`curl jina 失败: ${e.message.slice(0, 150)} | stderr: ${errText} | stdout: ${outText}`);
    }
    const text = buf.toString('utf8');
    const jinaErrors = [
        'AbuseAlleviationError', '"code":403', '40305',
        'SubmittedDataMalformedError', 'Domain .* could not be resolved',
        'Connection error', 'TIMEOUT',
    ];
    if (jinaErrors.some((pat) => new RegExp(pat).test(text))) {
        throw new Error('Jina 错误: ' + text.slice(0, 80).replace(/\s+/g, ' '));
    }
    return { ok: true, buf, contentType: 'text/markdown; charset=utf-8' };
}

function stripJinaHeader(text) {
    // 形如 "Title: xxx\nURL Source: xxx\n(Published Time / Warning ...)\nMarkdown Content:\n\n<正文>"
    const m = text.match(/Markdown Content:\s*\n+([\s\S]*)$/);
    return m ? m[1].trimStart() : text;
}

/** 内容质量检查: 是否抓到了无价值的拦截页/验证页/空页 */
function looksLikeBlockPage(text, contentType, url) {
    if (!text || !text.trim()) return true;
    const low = text.toLowerCase();
    const head = low.slice(0, 500); // 拦截页特征集中在开头

    // 强信号 (整页或开头): 英文明确 block / JS 验证墙
    const strong = [
        'your request has been blocked',
        'whoa there, pardner',
        'blocked due to a network policy',
        'you\'ve been blocked by network security',
        'you have been blocked by network security',
        'please enable javascript and cookies',
        'enable javascript and cookies to continue',
        'attention required!',
        'cf-chl',
        'just a moment...',
        'you need to enable javascript to run this app',
    ];
    if (strong.some((s) => low.includes(s))) return true;

    // 中文验证/拦截词: 只有出现在开头 500 字符才判定 (正文页脚出现不算)
    const zhHead = [
        '验证码', '人机验证', '访问过于频繁', '请输入验证码',
        '访问被拒绝', '请求被拒绝', '抱歉，您访问的页面不存在',
        '欢迎来到知乎，发现问题背后的世界',
        '为了提供更好的服务，请完成验证',
    ];
    if (zhHead.some((s) => head.includes(s))) return true;

    // 大量 base64 图片噪音 (Reddit 拦截页特征)
    const dataImg = (low.match(/data:image\/[a-z+]+;base64/g) || []).length;
    if (dataImg > 5) return true;

    // 极短响应且不是已知明文小文件 → 失败 (扩展名匹配 URL, 不是内容)
    const isTinyAllowed = /\.(md|txt|json|xml|csv|log|ico|svg|png|jpg|webp|diff|patch|yaml|yml|toml|ini|conf)(\?|#|$)/i.test(url || '');
    if (lenBytes(text) < 30 && !isTinyAllowed) return true;
    return false;
}

function lenBytes(s) {
    try { return Buffer.byteLength(s, 'utf8'); } catch { return s.length; }
}

async function main() {
    const argv = process.argv.slice(2);
    let url = null, format = 'markdown', timeoutSec = 30, noFallback = false, verbose = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--url' || a === '-u') url = argv[++i];
        else if (a === '--format' || a === '-f') format = argv[++i];
        else if (a === '--timeout' || a === '-t') timeoutSec = parseInt(argv[++i], 10) || 30;
        else if (a === '--no-fallback') noFallback = true;
        else if (a === '--verbose') verbose = true;
        else if (!url) url = a;
    }
    if (!url || !/^https?:\/\//i.test(url)) {
        process.stderr.write('missing valid url; use --url <http(s)://...> [-f markdown|text|html] [-t seconds] [--no-fallback] [--verbose]\n');
        process.exitCode = 1;
        return;
    }
    if (!['markdown', 'text', 'html'].includes(format)) {
        process.stderr.write(`invalid format "${format}"; use markdown, text or html\n`);
        process.exitCode = 1;
        return;
    }
    if (url.startsWith('http://')) url = 'https://' + url.slice(7); // http -> https

    const timeoutMs = Math.min(timeoutSec * 1000, MAX_TIMEOUT_MS);
    let acceptHeader = '*/*';
    if (format === 'markdown') {
        acceptHeader = 'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1';
    } else if (format === 'text') {
        acceptHeader = 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1';
    } else {
        acceptHeader = 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1';
    }
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        Accept: acceptHeader,
        'Accept-Language': 'en-US,en;q=0.9',
    };

    const log = (msg) => { if (verbose) process.stderr.write(`[fetch-v2] ${msg}\n`); };

    // ---- 降级链执行 ----
    // 顺序: 原生 fetch → curl 本地代理回退 → Jina 云端服务(最后手段, 有速率限制)
    const stages = [];
    stages.push({ name: 'fetch', run: () => stageFetch(url, headers, timeoutMs) });
    if (!noFallback) {
        stages.push({ name: 'curl', run: () => stageCurl(url, headers, timeoutMs) });
        stages.push({ name: 'jina', run: () => stageJina(url, timeoutMs) });
    }

    let lastErr = null;
    for (const stage of stages) {
        log(`trying [${stage.name}] for ${url}`);
        try {
            const r = await stage.run();
            const buf = r.buf;
            if (buf && buf.byteLength > MAX_RESPONSE_SIZE) {
                log(`[${stage.name}] 响应过大 (>5MB), 放弃`);
                lastErr = new Error(`response too large (>5MB) [stage:${stage.name}]`);
                continue;
            }
            const contentType = r.contentType || '';
            let content = buf.toString('utf8');
            const isRawFile = /\.(md|txt|json|xml|csv|log|diff|patch|yaml|yml|toml|ini|conf)(\?|#|$)/i.test(url);

            if (stage.name === 'jina') {
                // Jina 直接返回 Markdown/文本(已去元数据头)
                content = stripJinaHeader(content);
                if (format === 'text') {
                    content = content.replace(/[#*`>|+\-]/g, ' ').replace(/\s+/g, ' ').trim();
                } else if (format === 'html') {
                    process.stderr.write('[fetch-v2] warning: Jina 返回 Markdown 而非原始 HTML，已输出 Markdown 代替\n');
                }
            } else if (isRawFile && format !== 'html') {
                // raw 文件(README.md 等)原样输出
            } else if (contentType.includes('text/html') || stage.name === 'curl') {
                // 原生 fetch / curl 返回 HTML → 按格式转换
                content = format === 'text' ? extractTextFromHTML(content) : convertHTMLToMarkdown(content);
            }

            // 内容质量检查
            if (looksLikeBlockPage(content, contentType, url)) {
                log(`[${stage.name}] 判定为拦截/验证/空页 (${content.length}B), 继续降级`);
                lastErr = new Error(`blocked/empty page (${content.length}B) [stage:${stage.name}]`);
                continue;
            }
            process.stdout.write(content);
            return;
        } catch (err) {
            const cause = err.cause && err.cause.message ? err.cause.message : '';
            log(`[${stage.name}] 失败: ${err.message}${cause ? ` (${cause})` : ''}`);
            lastErr = err;
        }
    }
    process.stderr.write(`fetch failed: ${lastErr ? lastErr.message : 'unknown'} (all stages exhausted)\n`);
    process.exitCode = 1;
}

main();