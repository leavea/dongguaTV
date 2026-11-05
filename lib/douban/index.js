'use strict';

// 豆瓣数据源（参考 MoonTVPlus 的接口用法，按本项目 Express/CommonJS 结构实现）
// 仅使用豆瓣公开页面/移动端 JSON 接口，不依赖官方 API Key。
// 所有请求集中在 lib/douban，接口变化时只需要改这一处。

const axios = require('axios');

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const BASE_HEADERS = {
    'User-Agent': UA,
    'Referer': 'https://movie.douban.com/',
    'Origin': 'https://movie.douban.com',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const TTL = {
    list: 30 * 60 * 1000,
    recent: 30 * 60 * 1000,
    detail: 6 * 60 * 60 * 1000,
    search: 10 * 60 * 1000,
    hero: 30 * 60 * 1000,
    fail: 60 * 1000,
};

const CACHE_MAX = 600;
const mem = new Map();          // key -> { v, exp }
const failAt = new Map();       // key -> timestamp
const inflight = new Map();     // key -> Promise

let budgetStart = 0;
let budgetCount = 0;
const BUDGET_WINDOW = 60 * 1000;
const BUDGET_MAX = 300;         // 全站每分钟最多 300 次豆瓣 JSON 请求

class DoubanError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'DoubanError';
        this.code = code || 'DOUBAN_ERROR';
    }
}

function now() { return Date.now(); }

function cacheGet(key) {
    const hit = mem.get(key);
    if (!hit) return undefined;
    if (hit.exp <= now()) { mem.delete(key); return undefined; }
    return hit.v;
}

function cacheSet(key, value, ttl) {
    if (!(ttl > 0)) return;
    mem.delete(key);
    mem.set(key, { v: value, exp: now() + ttl });
    while (mem.size > CACHE_MAX) {
        const k = mem.keys().next().value;
        mem.delete(k);
    }
}

function budgetOk() {
    const t = now();
    if (t - budgetStart > BUDGET_WINDOW) {
        budgetStart = t;
        budgetCount = 0;
    }
    if (budgetCount >= BUDGET_MAX) return false;
    budgetCount++;
    return true;
}

function once(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

function httpsUrl(u) {
    return String(u || '').trim().replace(/^http:\/\//i, 'https://');
}

function yearOf(s) {
    const m = String(s || '').match(/(?:19|20)\d{2}/);
    return m ? m[0] : '';
}

function proxyUrl(cover) {
    return cover ? '/api/douban-image?url=' + encodeURIComponent(cover) : '';
}

function imageAllowed(raw) {
    try {
        const u = new URL(String(raw));
        if (!/^https?:$/i.test(u.protocol)) return false;
        const h = u.hostname.toLowerCase();
        return h === 'doubanio.com' || h.endsWith('.doubanio.com') ||
            h === 'douban.com' || h.endsWith('.douban.com');
    } catch (e) {
        return false;
    }
}

async function getJson(url, cacheKey, ttl) {
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;

    const failed = failAt.get(cacheKey);
    if (failed && now() - failed < TTL.fail) {
        throw new DoubanError('douban 最近请求失败，稍后重试', 'DOUBAN_RECENT_FAIL');
    }

    return once(cacheKey, async () => {
        if (!budgetOk()) throw new DoubanError('douban 请求预算已用完', 'DOUBAN_BUDGET');

        let res;
        try {
            res = await axios.get(url, {
                headers: BASE_HEADERS,
                timeout: 10000,
                maxRedirects: 0, // 被反爬时不跟随 sec.douban.com，直接暴露出来
                validateStatus: (s) => s >= 200 && s < 300,
            });
        } catch (e) {
            const status = e.response && e.response.status;
            const loc = e.response && e.response.headers && e.response.headers.location;
            failAt.set(cacheKey, now());
            console.warn('[Douban] request failed:', status || e.code || e.message, loc ? '-> ' + loc : '');
            throw new DoubanError(
                'douban request failed: ' + (status || e.code || e.message) + (loc ? ' -> ' + loc : ''),
                status === 302 ? 'DOUBAN_VERIFY' : (e.code || 'DOUBAN_ERROR')
            );
        }

        const data = res.data;
        if (!data || (typeof data !== 'object' && !Array.isArray(data))) {
            failAt.set(cacheKey, now());
            throw new DoubanError('douban returned non-json', 'DOUBAN_BAD_BODY');
        }

        failAt.delete(cacheKey);
        cacheSet(cacheKey, data, ttl);
        return data;
    });
}

function mapSubject(s) {
    return {
        id: String(s.id || ''),
        title: String(s.title || ''),
        cover: httpsUrl(s.cover || s.img || ''),
        rate: Number(s.rate) || 0,
        year: yearOf(s.card_subtitle),
        card_subtitle: String(s.card_subtitle || ''),
    };
}

function mapRecentItem(it) {
    const pic = it.pic || {};
    return {
        id: String(it.id || ''),
        title: String(it.title || ''),
        cover: httpsUrl(pic.normal || pic.large || ''),
        rate: Number(it.rating && it.rating.value) || 0,
        year: yearOf(it.card_subtitle),
        card_subtitle: String(it.card_subtitle || ''),
    };
}

function parseRuntime(durations) {
    if (!Array.isArray(durations) || !durations.length) return 0;
    const m = String(durations[0]).match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
}

function mapDetail(d) {
    const pic = d.pic || {};
    return {
        id: String(d.id || ''),
        title: String(d.title || ''),
        original_title: String(d.original_title || ''),
        year: String(d.year || ''),
        type: d.is_tv ? 'tv' : 'movie',
        overview: String(d.intro || ''),
        vote_average: Number(d.rating && d.rating.value) || 0,
        genres: Array.isArray(d.genres) ? d.genres : [],
        directors: (Array.isArray(d.directors) ? d.directors : [])
            .map((x) => x && x.name).filter(Boolean),
        actors: (Array.isArray(d.actors) ? d.actors : [])
            .slice(0, 12).map((x) => x && x.name).filter(Boolean),
        cover: httpsUrl(d.cover_url || pic.large || pic.normal || ''),
        durations: Array.isArray(d.durations) ? d.durations : [],
        runtime: parseRuntime(d.durations),
        episodes_count: Number(d.episodes_count) || 0,
        url: String(d.url || ''),
    };
}

// 统一成前端现有的“TMDB 形状”，卡片/详情弹窗几乎不用改模板
function cardOf(item, kind) {
    const img = proxyUrl(item.cover);
    return {
        id: item.id,
        title: item.title,
        media_type: kind === 'tv' ? 'tv' : 'movie',
        poster_path: img,
        backdrop_path: img,
        vote_average: item.rate || 0,
        release_date: item.year || '',
        overview: '',
        original_title: '',
        _douban: true,
    };
}

async function listByTag(kind, tag, start, limit) {
    if (!/^[a-z]+$/i.test(String(kind || ''))) throw new DoubanError('bad kind', 'DOUBAN_BAD_PARAM');
    if (!tag) throw new DoubanError('bad tag', 'DOUBAN_BAD_PARAM');
    const s = Math.max(0, parseInt(start, 10) || 0);
    const n = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const url = 'https://movie.douban.com/j/search_subjects' +
        '?type=' + encodeURIComponent(kind) +
        '&tag=' + encodeURIComponent(tag) +
        '&sort=recommend&page_limit=' + n + '&page_start=' + s;
    const data = await getJson(url, 'tag:' + kind + ':' + tag + ':' + s + ':' + n, TTL.list);
    const arr = Array.isArray(data.subjects) ? data.subjects : [];
    return {
        list: arr.map(mapSubject).filter((x) => x.id && x.title && x.cover).map((x) => cardOf(x, kind)),
        raw: arr,
    };
}

async function recentHot(kind, category, type, start, limit) {
    if (!['movie', 'tv'].includes(kind)) throw new DoubanError('bad kind', 'DOUBAN_BAD_PARAM');
    const s = Math.max(0, parseInt(start, 10) || 0);
    const n = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const url = 'https://m.douban.com/rexxar/api/v2/subject/recent_hot/' + kind +
        '?start=' + s + '&limit=' + n +
        '&category=' + encodeURIComponent(category || '热门') +
        '&type=' + encodeURIComponent(type || '全部');
    const data = await getJson(url, 'recent:' + kind + ':' + category + ':' + type + ':' + s + ':' + n, TTL.recent);
    const arr = Array.isArray(data.items) ? data.items : [];
    return {
        list: arr.map(mapRecentItem).filter((x) => x.id && x.title && x.cover).map((x) => cardOf(x, kind)),
        raw: arr,
        total: Number(data.total) || 0,
    };
}

async function detail(id) {
    const key = String(id || '').trim();
    if (!/^\d+$/.test(key)) throw new DoubanError('bad id', 'DOUBAN_BAD_PARAM');
    const data = await getJson(
        'https://m.douban.com/rexxar/api/v2/subject/' + encodeURIComponent(key),
        'detail:' + key,
        TTL.detail
    );
    return mapDetail(data);
}

async function search(q) {
    const query = String(q || '').trim().slice(0, 100);
    if (!query) return [];
    const data = await getJson(
        'https://movie.douban.com/j/subject_suggest?q=' + encodeURIComponent(query),
        'search:' + query,
        TTL.search
    );
    const arr = Array.isArray(data) ? data : [];
    return arr.map((s) => ({
        id: String(s.id || ''),
        title: String(s.title || ''),
        year: yearOf(s.year),
        cover: httpsUrl(s.img || ''),
        type: String(s.type || ''),
        episode: String(s.episode || ''),
        sub_title: String(s.sub_title || ''),
    })).filter((x) => x.id && x.title);
}

async function hero() {
    const cached = cacheGet('hero');
    if (cached !== undefined) return cached;
    return once('hero', async () => {
        const hot = await recentHot('movie', '热门', '全部', 0, 5);
        const items = await Promise.all(hot.list.map(async (card) => {
            let d = null;
            try { d = await detail(card.id); } catch (e) { /* 详情失败时用列表数据兜底 */ }
            const cover = d && d.cover ? d.cover : '';
            const img = cover ? proxyUrl(cover) : card.poster_path;
            const raw = Object.assign({}, card, d ? {
                overview: d.overview,
                vote_average: d.vote_average || card.vote_average,
                release_date: d.year || card.release_date,
                runtime: d.runtime,
                _doubanDetail: true,
            } : {});
            if (img) { raw.poster_path = img; raw.backdrop_path = img; }
            return {
                id: card.id,
                title: (d && d.title) || card.title,
                originalTitle: (d && d.original_title) || '',
                overview: (d && d.overview) || '精彩内容不容错过',
                backdrop: img,
                poster: img,
                vote_average: (d && d.vote_average) || card.vote_average || 0,
                release_date: (d && d.year) || card.release_date || '',
                media_type: 'movie',
                _douban: true,
                rawData: raw,
            };
        }));
        const result = { list: items.filter((x) => x.backdrop) };
        cacheSet('hero', result, TTL.hero);
        return result;
    });
}

module.exports = {
    listByTag,
    recentHot,
    detail,
    search,
    hero,
    imageAllowed,
    proxyUrl,
    DoubanError,
    _test: { mapSubject, mapRecentItem, mapDetail, cardOf, yearOf, parseRuntime, imageAllowed, proxyUrl },
};
