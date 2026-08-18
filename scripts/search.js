const fs = require('fs');
const os = require('os');
const path = require('path');

const PORTS = [8888, 8889];
const PAGEABLE_PORTS = [8888]; // only google cse supports pageno; bing (cn.bing.com) does not
const PORT_PARAMS = { 8889: { language: 'zh-CN' } }; // cn.bing.com needs a fixed region (mkt) or it returns unrelated hot recommendations
const WEIGHTS = { 8888: 13, 8889: 7 }; // google 13 : bing 7 (google results are higher quality)
const TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_FILE = path.join(os.homedir(), '.cache', 'searxng-search', 'cache.json');

function parseArgs(argv) {
    const args = { query: null, count: 8, page: 1 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--query' || a === '-q') args.query = argv[++i];
        else if (a === '--count' || a === '-n') args.count = parseInt(argv[++i], 10) || 8;
        else if (a === '--page' || a === '-p') args.page = parseInt(argv[++i], 10) || 1;
        else if (!args.query) args.query = a;
    }
    return args;
}

function readCache() {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
    catch { return {}; }
}

function writeCache(cache) {
    try {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    } catch (err) {
        // cache is best-effort; never fail the search because of it
        process.stderr.write(`cache write failed: ${err.message}\n`);
    }
}

function finish(code, payload) {
    if (payload) {
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    }
    process.exitCode = code;
}

async function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function queryPort(port, q, page) {
    const params = new URLSearchParams({ q, format: 'json', ...(PORT_PARAMS[port] || {}) });
    if (page > 1 && PAGEABLE_PORTS.includes(port)) {
        params.set('pageno', page);
    }
    const url = `http://127.0.0.1:${port}/search?${params.toString()}`;
    const res = await fetchWithTimeout(url, TIMEOUT_MS);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function main() {
    const { query, count, page } = parseArgs(process.argv.slice(2));
    if (!query) {
        process.stderr.write('missing query; use --query <text>\n');
        finish(1);
        return;
    }

    const cacheKey = `${query}|${page}`;
    const now = Date.now();
    const cache = readCache();
    const hit = cache[cacheKey];
    if (hit && now - hit.t < CACHE_TTL_MS) {
        const limited = (hit.results || []).slice(0, count);
        const cachedPayload = {
            ...hit,
            count: limited.length,
            results: limited,
            cached: true,
        };
        if (!cachedPayload.warnings) cachedPayload.warnings = [];
        cachedPayload.warnings.push('served from cache (10 min TTL); change wording or wait to refresh');
        finish(limited.length > 0 ? 0 : 1, cachedPayload);
        return;
    }

    const warnings = [];
    if (page > 1) {
        warnings.push('cn.bing.com does not support pagination; port 8889 results are page 1');
    }

    const portResults = await Promise.all(PORTS.map(async (port) => {
        try {
            const data = await queryPort(port, query, page);
            const rows = (data.results || []).map((r) => ({
                title: r.title || '',
                url: r.url || '',
                snippet: r.snippet || '',
                engine: r.engine || '',
                port,
            }));
            return { port, rows, error: null };
        } catch (err) {
            const cause = err.cause && err.cause.message ? err.cause.message : '';
            return { port, rows: [], error: `${err.name || 'Error'}: ${err.message}${cause ? ` (${cause})` : ''}` };
        }
    }));

    const errors = portResults.filter((r) => r.error).map((r) => ({ port: r.port, error: r.error }));

    // weighted round-robin (google 13 : bing 7), drop duplicate URLs;
    // keep the full weighted sequence for caching, then cap at `count`
    const perPortRows = portResults.map((pr) => pr.rows);
    const weights = portResults.map((pr) => WEIGHTS[pr.port] || 1);
    const taken = portResults.map(() => 0);
    const seen = new Set();
    const allMerged = [];
    while (true) {
        let best = -1;
        let bestScore = Infinity;
        for (let i = 0; i < perPortRows.length; i++) {
            if (taken[i] >= perPortRows[i].length) continue;
            const score = (taken[i] + 1) / weights[i];
            if (score < bestScore) {
                bestScore = score;
                best = i;
            }
        }
        if (best < 0) break;
        const row = perPortRows[best][taken[best]];
        taken[best]++;
        if (!row || !row.url || seen.has(row.url)) continue;
        seen.add(row.url);
        allMerged.push(row);
    }
    const results = allMerged.slice(0, count);

    const payload = {
        query,
        pageno: page,
        count: results.length,
        cached: false,
        results,
        errors,
        warnings,
    };

    // cache stores the full merged set (not truncated), so any -n can reuse it
    cache[cacheKey] = { ...payload, results: allMerged, t: now };
    writeCache(cache);

    finish(results.length > 0 ? 0 : 1, payload);
}

main();
