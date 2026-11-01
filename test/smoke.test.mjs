/**
 * test/smoke.test.mjs — 端到端冒烟：**不联网、不需要 cookie**。
 *
 * 现场用 ffmpeg 合成一段有真实切点的短片（三段不同图案拼起来），
 * 然后走一遍「引擎加载 → 扫描 → 分档 → 排布 → 取帧 → 拼图 → 清单」。
 *
 * 这一步的价值：把"移植过来的引擎在这台机器上到底跑不跑得起来"
 * 和"B站的登录/风控"彻底分开。前者坏了是本包的问题，后者坏了是账号的问题。
 *
 *   node test/smoke.test.mjs
 *
 * 环境变量：
 *   FFMPEG_PATH / FFMPEG  指定 ffmpeg（默认走 PATH）
 *   KEEP=1                跑完保留临时目录，便于看图和缓存
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEngine } from '../src/engine/load.js';

const ffmpeg = process.env.FFMPEG_PATH || process.env.FFMPEG || 'ffmpeg';
const keep = process.env.KEEP === '1';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${bin} 退出码 ${r.status}\n${(r.stderr || '').slice(-600)}`);
  }
  return r;
}

/** 合成一段 18 秒、有明显三段切换、带音轨的测试素材。 */
function makeFixture(dir) {
  const out = join(dir, 'fixture.mp4');
  run(ffmpeg, [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6',
    '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=25:duration=6',
    '-f', 'lavfi', '-i', 'rgbtestsrc=size=640x360:rate=25:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=420:duration=18',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-map', '3:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    '-c:a', 'aac', '-shortest',
    out,
  ]);
  return out;
}

console.log('视频读懂 · 端到端冒烟\n');

if (spawnSync(ffmpeg, ['-version'], { stdio: 'ignore', windowsHide: true }).status !== 0) {
  console.log(`跳过：这台机器上跑不了 ${ffmpeg}（装好 ffmpeg 或设 FFMPEG_PATH 再跑）。`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'video-reader-smoke-'));
let engine;
try {
  console.log('1) 加载引擎');
  const t0 = Date.now();
  engine = await loadEngine({ dataDir: dir, mediaMaxMB: 64 });
  check('引擎 import 通过', true, `${Date.now() - t0}ms`);
  check('媒体目录落在 dataDir 下', engine.mediaDir().startsWith(dir), engine.mediaDir());

  console.log('\n2) 合成测试素材');
  const fixture = makeFixture(dir);
  check('素材生成', existsSync(fixture), `${(statSync(fixture).size / 1048576).toFixed(1)} MB`);

  const info = await engine.probeVideo(fixture, {});
  check('ffprobe 读得到容器信息', Number(info.duration) > 10, `${Number(info.duration).toFixed(1)}s / ${info.width}x${info.height}`);
  check('音轨存在', Boolean(info.hasAudio));

  console.log('\n3) 出分镜');
  const options = engine.boardOptions({ input: fixture, transcript: 'off', ocr: false }, { kind: 'board' });
  const t1 = Date.now();
  const result = await engine.runStoryboard({
    ...options,
    ffmpegPath: ffmpeg,
    ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  });
  const took = ((Date.now() - t1) / 1000).toFixed(1);

  check('至少出一张图', result.sheets.length >= 1, `${result.sheets.length} 张 / ${took}s`);
  check('图里有切点', result.cuts.length >= 1, `${result.cuts.length} 个切点`);
  check('每张图都有 PNG 字节', result.sheets.every((s) => s.png && s.png.length > 1000),
    result.sheets.map((s) => `${s.width}x${s.height}:${(s.png.length / 1024).toFixed(0)}KB`).join(' '));
  check('每张图都有格子', result.sheets.every((s) => Array.isArray(s.cells) && s.cells.length > 0));

  console.log('\n4) 清单文本');
  const text = engine.formatForDetail(result, { detail: 'med', cellRange: null });
  check('清单提到 cell', /cell\s*\d/.test(text));
  check('清单带绝对时间', /\d{2}:\d{2}\.\d{2}/.test(text));
  check('清单长度合理', text.length < 24_000, `${text.length} 字符`);

  console.log('\n5) 纯文本翻页');
  const textOnly = await engine.runStoryboard({ ...options, textOnly: true, ffmpegPath: ffmpeg, ffprobePath: 'ffprobe' });
  check('textOnly 不出图', textOnly.sheets.length === 0);
  check('textOnly 仍有格子表', Array.isArray(textOnly.cells) && textOnly.cells.length > 0,
    `${textOnly.cells.length} 格`);

  console.log('\n6) cellId 寻址');
  const first = result.sheets[0].cells[0];
  await engine.runStoryboard({ ...options, ffmpegPath: ffmpeg, ffprobePath: 'ffprobe' }); // saveCells 已在上一步写过
  const hit = await engine.lookupCell(fixture, first.i);
  check('cellId 能还原绝对时间', Boolean(hit) && Math.abs(hit.from - first.t_start) < 0.01,
    hit ? `cell ${hit.i} = ${hit.from}-${hit.to}` : '查不到');

  console.log(`\n${failures === 0 ? '全部通过。' : `有 ${failures} 项没过。`}`);
} catch (error) {
  console.error(`\n未预期的失败：${error?.stack ?? error}`);
  failures += 1;
} finally {
  if (keep) console.log(`\n临时目录保留在 ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
