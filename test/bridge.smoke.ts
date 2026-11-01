/**
 * test/bridge.smoke.ts — B站链路冒烟。**默认只跑不联网的部分**；
 * 设了 `LIVE=1` 才真的去打 B站接口（匿名，验证请求/解析能通）。
 *
 *   node "<Coopanion>/resources/app/node_modules/tsx/dist/cli.mjs" test/bridge.smoke.ts
 *   LIVE=1 BILI_COOKIE="SESSDATA=...; bili_jct=..." node ... test/bridge.smoke.ts
 *
 * 为什么不放进 `npm test` 的默认路径：它依赖外网和 B站的风控状态，
 * 失败不能说明本包坏了。单元部分永远跑，联网部分按需。
 */

import { BilibiliClient, parsePlatformJson, stripSubtitleMarkup, videoId } from '../src/bridge/bilibili.ts';

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log('视频读懂 · B站链路冒烟\n');

console.log('1) 编号解析');
const cases: Array<[string, string | null]> = [
  ['BV1BK411Q7ys', 'BV1BK411Q7ys'],
  ['  BV1BK411Q7ys  ', 'BV1BK411Q7ys'],
  ['https://www.bilibili.com/video/BV1BK411Q7ys', 'BV1BK411Q7ys'],
  ['https://www.bilibili.com/video/BV1BK411Q7ys?p=3&t=10', 'BV1BK411Q7ys'],
  ['https://m.bilibili.com/video/BV1BK411Q7ys', 'BV1BK411Q7ys'],
  ['av170001', 'av170001'],
  ['https://www.bilibili.com/video/av170001', 'av170001'],
  ['https://www.youtube.com/watch?v=abc', null],
  ['https://www.bilibili.com/bangumi/play/ep123', null],
  ['随便一段话', null],
];
for (const [input, want] of cases) {
  let got: string | null = null;
  try {
    got = videoId(input);
  } catch {
    got = null;
  }
  check(`${JSON.stringify(input)} → ${want ?? '拒绝'}`, got === want, got === want ? '' : `实得 ${got}`);
}

console.log('\n2) 大整数保护（cid 真的会超过 2^53）');
const big = parsePlatformJson('{"cid":12345678901234567890,"aid":170001,"title":"x"}');
check('cid 保持字符串', typeof big.cid === 'string' && big.cid === '12345678901234567890', String(big.cid));
check('普通整数仍是数字', typeof big.aid === 'number' && big.aid === 170001);
const nested = parsePlatformJson('{"a":"12345678901234567890"}');
check('字符串里的数字不被改动', nested.a === '12345678901234567890');

console.log('\n3) 字幕文本清洗');
check('去标签', stripSubtitleMarkup('<i>你好</i>世界') === '你好世界');
check('去 ASS 标记', stripSubtitleMarkup('{\\an8}上方字幕') === '上方字幕');
check('实体还原', stripSubtitleMarkup('a&nbsp;b&amp;c') === 'a b&c');

if (!process.env.LIVE) {
  console.log('\n（跳过联网部分；设 LIVE=1 打开）');
  console.log(`\n${failures === 0 ? '全部通过。' : `有 ${failures} 项没过。`}`);
  process.exit(failures === 0 ? 0 : 1);
}

console.log('\n4) 真机：匿名读一条公开视频');
const cookie = process.env.BILI_COOKIE ?? '';
const client = new BilibiliClient(() => cookie);
const target = process.env.BILI_TARGET ?? 'BV1BK411Q7ys';
try {
  const meta = await client.view(target, 1);
  check('view 拿到元信息', Boolean(meta.bvid && meta.cid), `${meta.title} / ${meta.partDuration}s / ${meta.parts.length} 集`);

  const play = await client.playurl(meta, 480);
  check('playurl 拿到视频流', play.videos.length > 0 || Boolean(play.progressive),
    `${play.videos.length} 条 DASH / got ${play.height}p / 账号可到 ${play.qualityLabels.slice(-3).join('/')}`);
  check('降级有说明', play.height === null || play.height + 1 >= 480 || play.degraded.length > 0,
    play.degraded.join('; ') || '未降级');

  const sub = await client.subtitles(meta);
  check('字幕接口可用（有没有字幕都算通过）', true,
    sub.available ? `${sub.langDoc} ${sub.segments.length} 句` : sub.reason ?? '无字幕');

  check('登录状态如实报告', client.loggedIn === Boolean(cookie), client.loggedIn ? '已登录' : '匿名');
} catch (error) {
  console.error(`  真机测试失败：${(error as Error).message}`);
  failures += 1;
}

console.log(`\n${failures === 0 ? '全部通过。' : `有 ${failures} 项没过。`}`);
process.exit(failures === 0 ? 0 : 1);
