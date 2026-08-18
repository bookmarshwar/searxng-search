const http = require('node:http');
const path = require('node:path');

const TurndownService = require(path.join(__dirname, '..', 'node_modules', 'turndown'));

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5 MB, same as opencode webfetch
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const MAX_TIMEOUT_MS = 120 * 1000;

// honor http_proxy/https_proxy env vars (e.g. Clash at 127.0.0.1:7897),
// same approach opencode's sidecar uses
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
    // naive but sufficient plain-text extraction (same tag skip-list as opencode)
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

async function fetchWithTimeout(url, headers, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
    try {
        return await fetch(url, { signal: controller.signal, headers });
    } finally {
        clearTimeout(timer);
    }
}

async function get(url, headers, ms) {
    const res = await fetchWithTimeout(url, headers, ms);
    if (!res.ok) {
        // Cloudflare challenge: retry once with the opencode UA, like opencode does
        if (res.status === 403 && res.headers.get('cf-mitigated') === 'challenge') {
            const res2 = await fetchWithTimeout(url, { ...headers, 'User-Agent': 'opencode' }, ms);
            return res2;
        }
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return res;
}

async function main() {
    const argv = process.argv.slice(2);
    let url = null;
    let format = 'markdown';
    let timeoutSec = 30;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--url' || a === '-u') url = argv[++i];
        else if (a === '--format' || a === '-f') format = argv[++i];
        else if (a === '--timeout' || a === '-t') timeoutSec = parseInt(argv[++i], 10) || 30;
        else if (!url) url = a;
    }
    if (!url || !/^https?:\/\//i.test(url)) {
        process.stderr.write('missing valid url; use --url <http(s)://...> [-f markdown|text|html] [-t seconds]\n');
        process.exitCode = 1;
        return;
    }
    if (!['markdown', 'text', 'html'].includes(format)) {
        process.stderr.write(`invalid format "${format}"; use markdown, text or html\n`);
        process.exitCode = 1;
        return;
    }

    // upgrade http -> https like opencode
    if (url.startsWith('http://')) {
        url = 'https://' + url.slice(7);
    }

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

    let res;
    try {
        res = await get(url, headers, timeoutMs);
    } catch (err) {
        const cause = err.cause && err.cause.message ? err.cause.message : '';
        process.stderr.write(`fetch failed: ${err.message}${cause ? ` (${cause})` : ''}\n`);
        process.exitCode = 1;
        return;
    }

    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
        process.stderr.write('response too large (exceeds 5MB limit)\n');
        process.exitCode = 1;
        return;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_RESPONSE_SIZE) {
        process.stderr.write('response too large (exceeds 5MB limit)\n');
        process.exitCode = 1;
        return;
    }

    const contentType = res.headers.get('content-type') || '';
    const content = buf.toString('utf8');

    if (format === 'html') {
        process.stdout.write(content);
        return;
    }
    if (contentType.includes('text/html')) {
        process.stdout.write(format === 'text' ? extractTextFromHTML(content) : convertHTMLToMarkdown(content));
        return;
    }
    process.stdout.write(content);
}

main();