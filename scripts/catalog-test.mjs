#!/usr/bin/env node
// 分类浏览（豆瓣三个大类 + 小类筛选）回归（离线、零网络）：
//   node scripts/catalog-test.mjs
// 只测 public/index.html 里 <dg-catalog-core> 那段纯函数。
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

console.log('① 三个大类与小类标签');
{
    ok(eq(C.TYPES.map(t => t.k), ['movie', 'tv', 'variety']), '只保留电影 / 电视剧 / 综艺三个大类', C.TYPES.map(t => t.k));
    ok(eq(C.TYPES.map(t => t.l), ['电影', '电视剧', '综艺']), '大类名称', C.TYPES.map(t => t.l));
    const tags = (k) => C.TYPES.find(t => t.k === k).tags;
    ok(['热门', '最新', '豆瓣高分', '冷门佳片', '华语', '欧美', '韩国', '日本'].every(x => tags('movie').includes(x)), '电影保留完整小类', tags('movie'));
    ok(['最近热门', '国产', '欧美', '日本', '韩国', '纪录片'].every(x => tags('tv').includes(x)), '电视剧保留完整小类', tags('tv'));
    ok(['最近热门', '国内', '国外'].every(x => tags('variety').includes(x)), '综艺保留完整小类', tags('variety'));
    for (const T of C.TYPES) {
        ok(T.groups.length === 1 && T.groups[0].k === 'tag' && new Set(T.tags).size === T.tags.length, T.l + '：只有一组标签且不重复');
    }
    ok(C.typeOf('movie') && C.typeOf('tv') && C.typeOf('variety') && !C.typeOf('anime'), 'typeOf 不认已移除的动漫');
    ok(eq(C.normSel('movie', { tag: '华语' }), { tag: '华语' }), 'normSel 保留合法小类');
    ok(eq(C.normSel('movie', { tag: '不存在' }), { tag: '' }), 'normSel 过滤非法小类');
}

console.log('② buildQuery');
{
    let q = C.buildQuery('movie', {}, 1);
    ok(q.mode === 'tag' && q.kind === 'movie' && q.tag === '热门' && q.page === 1 && q.start === 0 && q.limit === 20, '电影默认热门');
    ok(C.buildQuery('movie', { tag: '豆瓣高分' }, 1).tag === '豆瓣高分', '电影小类直接作为豆瓣 tag');
    q = C.buildQuery('tv', {}, 1);
    ok(q.mode === 'recent' && q.kind === 'tv' && q.category === '最近热门' && q.type === 'tv', '电视剧默认最近热门/tv（电视剧，不是综艺）', q);
    q = C.buildQuery('tv', { tag: '国产' }, 1);
    ok(q.category === '热门' && q.type === 'tv_domestic', '国产剧 → 热门/tv_domestic', q);
    q = C.buildQuery('tv', { tag: '纪录片' }, 1);
    ok(q.category === '热门' && q.type === 'tv_documentary', '纪录片 → 热门/tv_documentary', q);
    q = C.buildQuery('tv', { tag: '欧美' }, 1);
    ok(q.category === '热门' && q.type === 'tv_american', '欧美剧 → 热门/tv_american', q);
    q = C.buildQuery('variety', { tag: '国内' }, 1);
    ok(q.mode === 'recent' && q.kind === 'tv' && q.category === '热门' && q.type === 'show_domestic', '国内综艺 → 热门/show_domestic', q);
    q = C.buildQuery('variety', { tag: '国外' }, 1);
    ok(q.mode === 'recent' && q.type === 'show_foreign', '国外综艺 → show_foreign', q);
    ok(C.buildQuery('movie', {}, 0).page === 1, '页码 0 → 1');
    ok(C.buildQuery('movie', {}, 999).page === 50, '页码最大 50');
    ok(C.buildQuery('movie', {}, 2).start === 20, '第 2 页 start=20');
}

console.log('③ 展示、目录与搜索词');
{
    const item = (name, extra) => Object.assign({ id: 1, title: name, poster_path: '/api/douban-image?url=x' }, extra || {});
    ok(C.visible(item('庆余年'), true), '有海报的中文名显示');
    ok(!C.visible(item('庆余年', { poster_path: '' }), true), '没有海报不显示');
    ok(!C.visible(item('玉蒲团'), true), '成人标题在过滤开启时不显示');
    ok(C.visible(item('玉蒲团'), false), '关掉过滤后显示');
    const g = C.groupsOf('tv', { tag: '国产' });
    ok(g.length === 1 && g[0].opts[0].k === '' && g[0].opts.some(x => x.k === '国产'), 'groupsOf 返回全部 + 小类', g);
    ok(C.navRows('movie').length === 1 && C.navRows('movie')[0].items.some(x => x.sel.tag === '华语'), 'navRows 返回小类快捷入口');
    ok(C.title('tv', { tag: '国产' }) === '电视剧 · 国产', 'title 带大类和小类', C.title('tv', { tag: '国产' }));
    ok(C.summary('movie', { tag: '豆瓣高分' }) === '电影 · 豆瓣高分', 'summary 与 title 一致');
    ok(C.countLabel(12000) === '1万+' && C.countLabel(0) === '0', 'countLabel');
    const d = C.directory();
    ok(d.hot.length >= 4 && d.hot.every(x => C.typeOf(x.type) && x.sel && x.sel.tag), 'directory.hot 都是有效大类/小类', d.hot);
    ok(d.types.length === 3 && d.types.every(t => t.rows && t.rows[0].items.length), 'directory.types 只有三个大类且都有小类', d.types.map(t => t.k));
}

console.log('④ 搜索词与榜单映射');
{
    const cases = [
        ['电影', 'movie', ''], ['华语电影', 'movie', '华语'], ['高分电影', 'movie', '豆瓣高分'],
        ['电视剧', 'tv', ''], ['美剧', 'tv', '欧美'], ['韩剧', 'tv', '韩国'], ['日剧', 'tv', '日本'],
        ['国产剧', 'tv', '国产'], ['纪录片', 'tv', '纪录片'], ['综艺', 'variety', ''], ['国内综艺', 'variety', '国内'],
    ];
    for (const [kw, type, tag] of cases) {
        const r = C.fromSearch(kw);
        ok(r && r.type === type && (r.sel.tag || '') === tag, 'fromSearch(' + kw + ') → ' + type + '/' + (tag || '默认'), r);
    }
    ok(C.fromSearch('动漫') === null && C.fromSearch('一部不存在的片名') === null, '已移除的动漫/未知词不当作分类');
    const rows = { movieHot: ['movie', '热门'], tvHot: ['tv', '最近热门'], tvShow: ['variety', '最近热门'] };
    for (const [key, [type, tag]] of Object.entries(rows)) {
        const r = C.rowPreset(key);
        ok(r && r.type === type && r.sel.tag === tag, 'rowPreset(' + key + ') → ' + type + '/' + tag, r);
    }
    ok(C.rowPreset('randomRow') === null && C.rowPreset('unknownRow') === null, '随机盲盒/未知行没有分类预设');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
