#!/usr/bin/env node
// 分类浏览（豆瓣标签版）回归（离线、零网络）：
//   node scripts/catalog-test.mjs
// 只测 public/index.html 里 <dg-catalog-core> 那段纯函数：
//   类型/标签定义自洽、buildQuery 生成的豆瓣参数、搜索词别名、榜单「全部」映射、成人标题过滤。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const coreM = /\/\/ <dg-catalog-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-catalog-core>/.exec(HTML);
if (!coreM) { console.log('✗ index.html 里找不到 <dg-catalog-core> 段'); process.exit(1); }
const C = vm.runInNewContext(coreM[1] + '\n;DgCatalog;', { Math, String, Array, Object, Number, Date, RegExp, JSON, parseInt });

console.log('① 类型与标签');
{
    ok(eq(C.TYPES.map(t => t.k), ['movie', 'tv', 'anime', 'variety']), '四个大类：电影 / 剧集 / 动漫 / 综艺', C.TYPES.map(t => t.k));
    for (const T of C.TYPES) {
        ok(T.groups.length === 1 && T.groups[0].k === 'tag', T.l + '：只有一组标签筛选', T.groups.map(g => g.k));
        ok(T.tags.length >= 3 && new Set(T.tags).size === T.tags.length, T.l + '：标签非空且不重复', T.tags);
        for (const n of T.nav) ok(n.g === 'tag' || n.items, T.l + '：首页分类栏引用的组存在', n);
    }
    ok(C.typeOf('movie') && C.typeOf('tv') && C.typeOf('anime') && C.typeOf('variety') && !C.typeOf('doc'), 'typeOf 认得四个大类、不认旧 doc', C.TYPES.map(t => t.k));
    ok(eq(C.normSel('movie', { tag: '热门' }), { tag: '热门' }), 'normSel 保留合法标签');
    ok(eq(C.normSel('movie', { tag: '不存在的标签' }), { tag: '' }), 'normSel 过滤非法标签');
    ok(eq(C.normSel('tv', { region: 'cn', tag: '国产', year: '2024', sort: 'top' }), { tag: '国产' }), 'normSel 丢掉旧版 region/year/sort');
}

console.log('② buildQuery');
{
    let q = C.buildQuery('movie', { tag: '热门' }, 1);
    ok(q.mode === 'tag' && q.kind === 'movie' && q.tag === '热门' && q.page === 1 && q.start === 0 && q.limit === 20, '电影走 tag 模式', q);
    q = C.buildQuery('movie', { tag: '不存在' }, 1);
    ok(q.mode === 'tag' && q.tag === '热门', '电影无效标签回落到热门', q);
    q = C.buildQuery('tv', { tag: '国产' }, 1);
    ok(q.mode === 'recent' && q.kind === 'tv' && q.category === '热门' && q.type === 'tv_domestic', '国产剧走 recent_hot:热门/tv_domestic', q);
    q = C.buildQuery('tv', { tag: '最近热门' }, 1);
    ok(q.category === '最近热门' && q.type === '全部', '剧集最近热门:最近热门/全部', q);
    q = C.buildQuery('tv', { tag: '纪录片' }, 1);
    ok(q.category === '热门' && q.type === 'tv_documentary', '纪录片:热门/tv_documentary', q);
    q = C.buildQuery('anime', { tag: '最近热门' }, 1);
    ok(q.mode === 'recent' && q.kind === 'tv' && q.category === '最近热门' && q.type === 'tv_animation', '动漫:最近热门/tv_animation', q);
    q = C.buildQuery('variety', { tag: '最近热门' }, 1);
    ok(q.mode === 'recent' && q.kind === 'tv' && q.category === '热门' && q.type === '综艺', '综艺:热门/综艺', q);
    ok(C.buildQuery('movie', {}, 0).page === 1, '页码 0 → 1');
    ok(C.buildQuery('movie', {}, 999).page === 50, '页码夹到 50');
    ok(C.buildQuery('movie', {}, 2).start === 20 && C.buildQuery('movie', {}, 2).limit === 20, '第 2 页 start=20');
}

console.log('③ 展示与映射');
{
    const item = (name, extra) => Object.assign({ id: 1, title: name, poster_path: '/api/douban-image?url=x' }, extra || {});
    ok(C.visible(item('庆余年'), true), '有海报的中文名显示');
    ok(!C.visible(item('庆余年', { poster_path: '' }), true), '没有海报不显示');
    ok(!C.visible(item('玉蒲团'), true), '成人标题在过滤开启时不显示');
    ok(C.visible(item('玉蒲团'), false), '关掉过滤后显示');
    const g = C.groupsOf('tv', { tag: '国产' });
    ok(g.length === 1 && g[0].k === 'tag' && g[0].opts[0].k === '' && g[0].opts.some(x => x.k === '国产'), 'groupsOf 返回标签组 + 全部', g);
    ok(C.navRows('movie').length === 1 && C.navRows('movie')[0].items.some(x => x.sel.tag === '热门'), 'navRows 返回标签快捷入口', C.navRows('movie'));
    ok(C.title('tv', { tag: '国产' }) === '剧集 · 国产', 'title 带类型和标签', C.title('tv', { tag: '国产' }));
    ok(C.summary('movie', { tag: '豆瓣高分' }) === '电影 · 豆瓣高分', 'summary 与 title 一致');
    ok(C.countLabel(12000) === '1万+' && C.countLabel(0) === '0', 'countLabel');
    const d = C.directory();
    ok(d.hot.length >= 4 && d.hot.every(x => C.typeOf(x.type) && x.sel && x.sel.tag), 'directory.hot 都是有效类型/标签', d.hot);
    ok(d.types.length === 4 && d.types.every(t => t.rows && t.rows[0].items.length), 'directory.types 每个大类都有标签行', d.types.map(t => t.k));
}

console.log('④ 搜索词与榜单映射');
{
    const cases = [
        ['电影', 'movie', ''], ['电视剧', 'tv', ''], ['美剧', 'tv', '欧美'],
        ['韩剧', 'tv', '韩国'], ['日剧', 'tv', '日本'], ['国产剧', 'tv', '国产'],
        ['纪录片', 'tv', '纪录片'], ['动漫', 'anime', ''], ['综艺', 'variety', ''],
        ['华语电影', 'movie', '华语'], ['高分电影', 'movie', '豆瓣高分'],
    ];
    for (const [kw, type, tag] of cases) {
        const r = C.fromSearch(kw);
        ok(r && r.type === type && (r.sel.tag || '') === tag, 'fromSearch(' + kw + ') → ' + type + '/' + (tag || '默认'), r);
    }
    ok(C.fromSearch('一部不存在的片名') === null, '未知词不当作分类');
    const rows = {
        movieHot: ['movie', '热门'], movieTop: ['movie', '豆瓣高分'], movieCN: ['movie', '华语'],
        tvHot: ['tv', '最近热门'], tvCN: ['tv', '国产'], tvAnime: ['anime', '最近热门'],
        tvShow: ['variety', '最近热门'], tvDoc: ['tv', '纪录片'],
    };
    for (const [key, [type, tag]] of Object.entries(rows)) {
        const r = C.rowPreset(key);
        ok(r && r.type === type && r.sel.tag === tag, 'rowPreset(' + key + ') → ' + type + '/' + tag, r);
    }
    ok(C.rowPreset('randomRow') === null && C.rowPreset('unknownRow') === null, '随机盲盒/未知行没有分类预设');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
