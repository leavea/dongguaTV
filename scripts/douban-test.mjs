#!/usr/bin/env node
// 豆瓣数据模块回归（离线、零网络）：
//   node scripts/douban-test.mjs
// 只测 lib/douban 里的纯映射/URL 白名单，不请求豆瓣。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const d = require(path.join(ROOT, 'lib/douban'));
const T = d._test;

let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };

console.log('① 基础映射');
{
    ok(T.yearOf('2026 / 中国大陆 / 剧情') === '2026', 'yearOf 从 card_subtitle 取年份');
    ok(T.yearOf('暂无年份') === '', 'yearOf 没有年份返回空');
    ok(T.parseRuntime(['45分钟']) === 45, 'parseRuntime 取分钟数');
    ok(T.parseRuntime(['1小时30分钟']) === 1, 'parseRuntime 只取第一个数字（保持与详情接口一致）');
    ok(T.parseRuntime([]) === 0 && T.parseRuntime(null) === 0, 'parseRuntime 空值返回 0');

    const r = T.mapRecentItem({
        id: '123', title: '小城良方',
        card_subtitle: '2026 / 中国大陆 / 剧情',
        pic: { large: 'http://img2.doubanio.com/a.jpg' },
        rating: { value: 8.2 },
    });
    ok(r.id === '123' && r.title === '小城良方' && r.cover.startsWith('https://') && r.rate === 8.2 && r.year === '2026', 'mapRecentItem 映射完整', r);

    const s = T.mapSubject({ id: '9', title: '黑球', cover: 'http://img9.doubanio.com/b.jpg', rate: '8.6', card_subtitle: '2026' });
    ok(s.id === '9' && s.rate === 8.6 && s.year === '2026' && s.cover.startsWith('https://'), 'mapSubject 映射完整', s);

    const m = T.mapDetail({
        id: '9', title: '黑球', original_title: 'La bola negra', year: '2026', is_tv: false,
        intro: '简介', rating: { value: 8.6 }, genres: ['剧情'],
        directors: [{ name: '导演A' }], actors: [{ name: '演员A' }, { name: '演员B' }],
        cover_url: 'http://img9.doubanio.com/c.jpg', durations: ['45分钟'], episodes_count: 0,
    });
    ok(m.overview === '简介' && m.vote_average === 8.6 && m.runtime === 45 && m.genres[0] === '剧情' && m.directors[0] === '导演A' && m.actors.length === 2, 'mapDetail 映射完整', m);
}

console.log('② 卡片形状与图片代理');
{
    const c = T.cardOf({ id: '9', title: '黑球', cover: 'https://img9.doubanio.com/b.jpg', rate: 8.6, year: '2026' }, 'movie');
    ok(c.id === '9' && c.title === '黑球' && c.media_type === 'movie' && c.vote_average === 8.6 && c.release_date === '2026' && c._douban === true, 'cardOf 生成 TMDB 形状卡片', c);
    ok(c.poster_path.startsWith('/api/douban-image?url=') && c.poster_path.includes(encodeURIComponent('https://img9.doubanio.com/b.jpg')), 'cardOf 海报走 /api/douban-image 并编码', c.poster_path);
    ok(T.proxyUrl('https://img9.doubanio.com/a b.jpg').startsWith('/api/douban-image?url='), 'proxyUrl 生成编码后的代理地址');
    ok(T.proxyUrl('') === '', 'proxyUrl 空值返回空');
}

console.log('③ 图片 URL 白名单');
{
    const allow = [
        'https://img1.doubanio.com/view/photo/a.jpg',
        'https://img9.doubanio.com/view/photo/a.jpg',
        'https://movie.douban.com/a.jpg',
        'https://douban.com/a.jpg',
    ];
    const deny = [
        'https://evil.com/a.jpg',
        'https://doubanio.com.evil.com/a.jpg',
        'https://douban.com@evil.com/a.jpg',
        'http://127.0.0.1/a.jpg',
        'http://localhost/a.jpg',
        'file:///etc/passwd',
        'javascript:alert(1)',
        '',
        null,
    ];
    for (const u of allow) ok(T.imageAllowed(u), '允许豆瓣图床: ' + u);
    for (const u of deny) ok(!T.imageAllowed(u), '拒绝非豆瓣地址: ' + String(u));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
