/**
 * test/world.local.ts — 走**真实的 World 工具 handler**，只是把视频换成合成素材。
 *
 * 和 `smoke.test.mjs` 的分工：
 *   - smoke 测引擎（切点/分档/排布/拼图）能不能跑；
 *   - 这个测**本包的胶水**：预算账本、降级说明、blobs 交付、cellId 寻址、textOnly 分支。
 * 两者都不联网，所以失败一定是本包的问题。
 *
 *   node "<Coopanion>/resources/app/node_modules/tsx/dist/cli.mjs" test/world.local.ts
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// World 的运行时依赖只有 describeTools；指到桩上就能在桌宠之外构造它。
const stubUrl = new URL('./stub-cortico-world.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cortico/world.ts' || specifier === 'cortico/core/types.ts') {
      return { url: stubUrl, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const ffmpeg = process.env.FFMPEG_PATH || process.env.FFMPEG || 'ffmpeg';
const keep = process.env.KEEP === '1';

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

function run(bin: string, args: string[]) {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${bin} 退出码 ${r.status}\n${(r.stderr || '').slice(-600)}`);
  return r;
}

function makeFixture(dir: string): string {
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

console.log('视频读懂 · World 集成（本地素材）\n');

if (spawnSync(ffmpeg, ['-version'], { stdio: 'ignore', windowsHide: true }).status !== 0) {
  console.log(`跳过：这台机器上跑不了 ${ffmpeg}。`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'video-reader-world-'));

try {
  const fixture = makeFixture(dir);

  const mod: any = await import(new URL('../src/index.ts', import.meta.url).href);
  const def = mod.default;

  const ctx = {
    id: def.id,
    cfg: def.defaults(),
    timezone: 'Asia/Shanghai',
    botName: 'test',
    botDir: dir,
    packageDir: new URL('..', import.meta.url).pathname,
    dataDir: join(dir, 'data'),
    repoRoot: dir,
    secret: () => '',
    storeSecret: () => {},
    persist: () => {},
    restart: async () => {},
  };

  const world = def.create(ctx);
  const handlers = new Map(world.tools().map((t: any) => [t.name, t.handler]));

  console.log('1) video_probe（本地文件）');
  const probe: any = await handlers.get('video_probe')({ video: fixture }, {});
  check('成功回执', probe.failed !== true, probe.failed ? String(probe.text).slice(0, 200) : '');
  check('报了时长', /duration="18\./.test(probe.text), probe.text.split('\n')[0]);
  check('给了读法建议', /video_storyboard/.test(probe.text));
  check('本地文件不承诺下载', /nothing is downloaded/.test(probe.text));

  console.log('\n2) video_storyboard（出图）');
  const board: any = await handlers.get('video_storyboard')({ video: fixture, transcript: 'off' }, {});
  check('成功回执', board.failed !== true, board.failed ? String(board.text).slice(0, 300) : '');
  check('返回了图片', Array.isArray(board.blobs) && board.blobs.length > 0, `${board.blobs?.length ?? 0} 张`);
  check('图片是 PNG 字节', board.blobs?.every((b: any) => b.mime === 'image/png' && b.bytes?.length > 1000),
    board.blobs?.map((b: any) => `${(b.bytes.length / 1024).toFixed(0)}KB`).join(' '));
  check('图片带 fallbackText', board.blobs?.every((b: any) => typeof b.fallbackText === 'string' && b.fallbackText));
  check('文本有格号与时间', /cell\s*\d/.test(board.text) && /\d{2}:\d{2}\.\d{2}/.test(board.text));
  check('头部说明了缓存与分辨率', /\[cache\]/.test(board.text) && /\[resolution\]/.test(board.text));
  check('尾部声明依据', /\[依据\]/.test(board.text));
  // 合成素材的音轨是正弦波，没有任何台词 → 必须报「一个字都没有」
  check('无台词素材会报台词密度', /台词密度\].*一个字都没有|台词密度\].*没有可读的台词/.test(board.text),
    (board.text.split('\n').find((l: string) => /台词密度\]/.test(l)) ?? '（没有这一行）').slice(0, 90));
  check('没有假装看过全片', /不包含完整观看|未听音轨|画面之外/.test(board.text) || /画面之外的事不要当成看到过/.test(board.text));

  console.log('\n3) 预算账本');
  const usage = JSON.parse(
    await import('node:fs').then((fs) => fs.readFileSync(join(ctx.dataDir, 'worlds', 'video-reader', 'state', 'usage.json'), 'utf8')),
  );
  check('记了一次出图', usage.calls === 1, `calls=${usage.calls}`);
  check('记了交付字节', usage.deliveredBytes > 0, `${(usage.deliveredBytes / 1024).toFixed(0)}KB`);

  // **目录必须私有**：ctx.dataDir 是全部署共享的（宿主的图片附件就在 data/media 里）
  const root = join(ctx.dataDir, 'worlds', 'video-reader');
  check('媒体落在私有目录', existsSync(join(root, 'media')), join(root, 'media'));
  check('扫描缓存落在私有目录', existsSync(join(root, 'cache')));
  check('字幕落在私有目录', existsSync(join(root, 'transcripts')));
  check('没有往共享 data/media 里写视频副本',
    !existsSync(join(ctx.dataDir, 'media')) || readdirSync(join(ctx.dataDir, 'media')).filter((n: string) => /^[a-f0-9]{20}$/.test(n)).length === 0);

  /**
   * **反向验证**：正常口播不该报警。
   * 用手写的台词文件（4.7 字/秒，接近 BV14oa961ELQ 的真实密度）跑一次 textOnly，
   * 那里不出图、但台词密度判据照样生效。
   */
  {
    const tdir = join(ctx.dataDir, 'worlds', 'video-reader', 'transcripts');
    const tf = join(tdir, 'dense.json');
    writeFileSync(tf, JSON.stringify({
      body: Array.from({ length: 60 }, (_, i) => ({
        from: i * 0.6, to: (i + 1) * 0.6,
        content: '这是一句正常人说的话内容大概八个字左',
      })),
    }), 'utf8');
    const r: any = await handlers.get('video_storyboard')({ video: fixture, transcriptFile: tf, textOnly: true }, {});
    check('高密度台词不报密度警告', !/台词密度\]/.test(r.text),
      (r.text.split('\n').find((l: string) => /台词密度\]/.test(l)) ?? '（没有这一行 ✓）').slice(0, 80));
  }

  console.log('\n4) textOnly（不算额度、不出图）');
  const textOnly: any = await handlers.get('video_storyboard')({ video: fixture, textOnly: true }, {});
  check('不出图', !textOnly.blobs || textOnly.blobs.length === 0);
  check('仍有文本索引', /cell\s*\d/.test(textOnly.text));
  check('说明本次没出图', /只有文本索引/.test(textOnly.text));
  const usage2 = JSON.parse(
    await import('node:fs').then((fs) => fs.readFileSync(join(ctx.dataDir, 'worlds', 'video-reader', 'state', 'usage.json'), 'utf8')),
  );
  check('textOnly 没有增加出图计数', usage2.calls === 1, `calls=${usage2.calls}`);

  console.log('\n5) video_zoom 用 cellId 寻址');
  const firstCell = /cell\s+(\d+)/.exec(board.text)?.[1] ?? '1';
  const zoom: any = await handlers.get('video_zoom')({ video: fixture, cellId: Number(firstCell) }, {});
  check('成功回执', zoom.failed !== true, zoom.failed ? String(zoom.text).slice(0, 300) : '');
  check('返回了放大图', Array.isArray(zoom.blobs) && zoom.blobs.length > 0, `${zoom.blobs?.length ?? 0} 张`);
  const usage3 = JSON.parse(
    await import('node:fs').then((fs) => fs.readFileSync(join(ctx.dataDir, 'worlds', 'video-reader', 'state', 'usage.json'), 'utf8')),
  );
  check('zoom 也计一次', usage3.calls === 2, `calls=${usage3.calls}`);

  console.log('\n6) cellId 找不到时的说法');
  const bad: any = await handlers.get('video_zoom')({ video: fixture, cellId: 9999 }, {});
  check('失败并给出下一步', bad.failed === true && /video_storyboard/.test(bad.text), String(bad.text).slice(0, 160));

  console.log('\n7) 缺参数 / 不支持的链接');
  const noArg: any = await handlers.get('video_storyboard')({}, {});
  check('空 video 直接失败', noArg.failed === true);
  const yt: any = await handlers.get('video_storyboard')({ video: 'https://www.youtube.com/watch?v=x' }, {});
  check('非 B站链接说明原因', yt.failed === true && /只支持 B站/.test(yt.text), String(yt.text).slice(0, 160));

  console.log('\n8) 额度用尽时转为文本');
  ctx.cfg.maxDailyCalls = 0;
  const blocked: any = await handlers.get('video_storyboard')({ video: fixture }, {});
  check('额度为 0 时拒绝出图', blocked.failed === true && /额度|次数/.test(blocked.text), String(blocked.text).slice(0, 160));
  ctx.cfg.maxDailyCalls = 60;

  console.log('\n9) WebUI 声明');
  const ui: any = world.webUi('zh');
  check('有配置页', Array.isArray(ui.config) && ui.config.length > 0);
  check('有状态灯', Array.isArray(ui.lamps) && ui.lamps.length >= 2, ui.lamps?.map((l: any) => `${l.label}:${l.state}`).join(' '));
  check('有数据页且能报体积', typeof ui.storage?.[0]?.stat === 'function' && typeof ui.storage[0].stat() === 'string',
    ui.storage?.[0]?.stat?.());
  check('有环境提示词', (ui.promptDocs ?? []).some((d: any) => d.role === 'envPrompt' && existsSync(d.path)));

  console.log('\n10) envPromptVars');
  const vars = world.envPromptVars();
  check('三个变量都给了', Boolean(vars['videoreader.login'] && vars['videoreader.ffmpeg'] && vars['videoreader.quota']),
    JSON.stringify(vars));

  console.log(`\n${failures === 0 ? '全部通过。' : `有 ${failures} 项没过。`}`);
} catch (error: any) {
  console.error(`\n未预期的失败：${error?.stack ?? error}`);
  failures += 1;
} finally {
  if (keep) console.log(`\n临时目录保留在 ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
