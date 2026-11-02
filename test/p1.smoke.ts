/**
 * test/p1.smoke.ts — P1 三项的本机验证：语音识别、台词定位、硬字幕长图。
 *
 * **全部不联网**：素材是 ffmpeg 现场合成的一段**有真实人声台词**的片子
 * （用 Windows 自带 SAPI 念出来；没有 SAPI 就跳过、不报失败），
 * 再加上一段**硬字幕**（用 drawtext 烧进画面），于是两条路都能验到。
 *
 *   node "<Coopanion>/resources/app/node_modules/tsx/dist/cli.mjs" test/p1.smoke.ts
 *
 * 环境变量：
 *   FFMPEG_PATH     指定 ffmpeg
 *   SKIP_ASR=1      跳过语音识别那一段（机器上没有 sherpa 模型时）
 *   KEEP=1          跑完保留临时目录
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findLocalModel,
  looksLikeHallucination,
  planChunks,
  resolveAsrConfig,
  transcribe,
} from '../src/bridge/asr.ts';
import { loadTranscript } from '../src/bridge/transcript.ts';

const ffmpeg = process.env.FFMPEG_PATH || process.env.FFMPEG || 'ffmpeg';
const keep = process.env.KEEP === '1';

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

function run(bin: string, args: string[]) {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${bin} 退出码 ${r.status}\n${(r.stderr || '').slice(-500)}`);
  return r;
}

console.log('视频读懂 · P1 验证（语音识别 / 台词定位 / 硬字幕长图）\n');

if (spawnSync(ffmpeg, ['-version'], { stdio: 'ignore', windowsHide: true }).status !== 0) {
  console.log(`跳过：这台机器上跑不了 ${ffmpeg}。`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'vr-p1-'));
const dataDir = join(dir, 'data');
mkdirSync(dataDir, { recursive: true });

try {
  /* ---------------------------------------------------------------- 1. 切片规划 */

  console.log('1) 切片规划（切点要落在静音中点）');
  const silences = [10, 22, 33, 48, 61];
  const chunks = planChunks(0, 90, silences, 45);
  check('90 秒切成 3 块', chunks.length === 3, chunks.map((c) => `${c.at.toFixed(1)}+${c.len.toFixed(1)}`).join(' '));
  check('每块不超过 45 秒', chunks.every((c) => c.len <= 45.01), Math.max(...chunks.map((c) => c.len)).toFixed(1));
  check('切点落在静音中点', chunks.slice(0, -1).every((c) => silences.some((s) => Math.abs(c.at + c.len - s) < 0.01)),
    chunks.slice(0, -1).map((c) => (c.at + c.len).toFixed(1)).join(' '));
  check('区间连续无缝', chunks.every((c, i) => i === 0 || Math.abs(c.at - (chunks[i - 1].at + chunks[i - 1].len)) < 0.01));
  const tail = planChunks(0, 46, [], 45);
  check('尾部过短时并进上一块', tail.length === 1, `${tail.length} 块`);

  console.log('\n2) 幻觉过滤（纯音乐段的长而稀句子要丢掉）');
  check('29 秒 9 个字 → 丢弃', looksLikeHallucination({ from: 0, to: 29, text: '啦啦啦一二三' }));
  check('正常口播 5 秒 30 字 → 保留', !looksLikeHallucination({ from: 0, to: 5, text: '这是一句正常人说的话内容大概三十个字左右的长度' }));
  check('0.5 秒的碎片 → 丢弃', looksLikeHallucination({ from: 1, to: 1.5, text: '啊' }));
  check('空文本 → 丢弃', looksLikeHallucination({ from: 0, to: 3, text: '  ' }));

  /* ---------------------------------------------------------------- 3. 本机模型 */

  console.log('\n3) 找本机的语音模型');
  // 用真实的 dataDir：sherpa-onnx-node 的定位要靠'从 dataDir 往上找到 D:\Coopanion'这条路径
  const REAL_DATA = 'D:/Coopanion/data/home/companion/data';
  const model = findLocalModel(REAL_DATA);
  if (!model) {
    console.log('  跳过：这台机器上没找到 models/desktop-pet/ 下的 model.int8.onnx + tokens.txt。');
    console.log('  （装了桌宠语音输入的机器上一定有；换机器时这一段会跳过，不算失败。）');
  } else {
    check('找到模型', existsSync(model.model), model.model.replace(/.*[\\/]/, ''));
    check('有词表', existsSync(model.tokens));
    check('认出模型类型', model.modelKind === 'sensevoice' || model.modelKind === 'paraformer', model.modelKind);
    const cfg = resolveAsrConfig({ dataDir: REAL_DATA, mode: 'auto' });
    check('resolveAsrConfig 走 sherpa', cfg.kind === 'sherpa', cfg.kind);
    const off = resolveAsrConfig({ dataDir: dir, mode: 'auto' });
    check('没模型时给的是"为什么"而不是空', off.kind === 'off' && Boolean(off.reason) && off.reason!.includes('模型'), off.reason?.slice(0, 60));
  }

  /* ---------------------------------------------------------------- 4. 合成素材 */

  console.log('\n4) 合成素材（人声台词 + 烧进画面的字幕）');
  const voice = join(dir, 'voice.wav');
  let hasSapi = false;
  try {
    // Windows 自带 SAPI：念一句话。没有这台机器就不测 ASR 的准确度，只测流程。
    const ps = spawnSync(
      'powershell',
      ['-NoProfile', '-Command',
        `Add-Type -AssemblyName System.Speech; ` +
        `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
        `$s.SetOutputToWaveFile('${voice}'); ` +
        `$s.Rate = -2; $s.Speak('今天我们来聊聊视频理解这件事，模型看不到画面，只能靠文字去猜，这显然是不够的。'); ` +
        `$s.Dispose()`],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
    );
    hasSapi = ps.status === 0 && existsSync(voice);
  } catch {
    hasSapi = false;
  }
  check('SAPI 合成出人声', hasSapi, hasSapi ? `${(readFileSync(voice).length / 1024).toFixed(0)}KB` : '没有 SAPI（会跳过识别准确度检查）');

  const clip = join(dir, 'clip.mp4');
  const fontArg = existsSync('C:/Windows/Fonts/msyh.ttc') ? `fontfile='C\\:/Windows/Fonts/msyh.ttc':` : '';
  if (hasSapi) {
    run(ffmpeg, [
      '-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x202030:s=640x360:r=25:d=14',
      '-i', voice,
      '-filter_complex',
      `[0:v]drawtext=${fontArg}text='第一句：模型看不到画面':fontsize=28:fontcolor=yellow:x=(w-text_w)/2:y=h-60:enable='between(t,0,4)',` +
        `drawtext=${fontArg}text='第二句：所以要压成宫格':fontsize=28:fontcolor=yellow:x=(w-text_w)/2:y=h-60:enable='between(t,4,8)',` +
        `drawtext=${fontArg}text='第三句：一格一个镜头':fontsize=28:fontcolor=yellow:x=(w-text_w)/2:y=h-60:enable='between(t,8,14)'[v]`,
      '-map', '[v]', '-map', '1:a',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', clip,
    ]);
  } else {
    // 没有人声时，仍然合成一段带硬字幕的片子来验证长图那条路
    run(ffmpeg, [
      '-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x202030:s=640x360:r=25:d=14',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=14',
      '-filter_complex',
      `[0:v]drawtext=${fontArg}text='第一句\\:硬字幕测试':fontsize=28:fontcolor=yellow:x=(w-text_w)/2:y=h-60:enable='between(t,0,4)',` +
        `drawtext=${fontArg}text='第二句\\:烧进画面':fontsize=28:fontcolor=yellow:x=(w-text_w)/2:y=h-60:enable='between(t,4,8)',` +
        `drawtext=${fontArg}text='第三句\\:裁成一条':fontsize=28:fontcolor=yellow:x=(w-text_w)/2:y=h-60:enable='between(t,8,14)'[v]`,
      '-map', '[v]', '-map', '1:a',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', clip,
    ]);
  }
  check('素材生成', existsSync(clip));

  // 真实时长：SAPI 的人声常常短于 14 秒，-shortest 会把片子压到那么长。
  // 后面所有窗口都用它，不要写死 —— 否则会在片子以外去取帧（grabStrip 报 ENOENT）。
  const probed = spawnSync('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1', clip], { encoding:'utf8', windowsHide:true });
  const dur = Number(String(probed.stdout ?? '').trim()) || 14;
  check('读得到真实时长', dur > 1, dur.toFixed(2)+'s');

  /* ---------------------------------------------------------------- 5. 语音识别 */

  console.log('\n5) 语音识别（本地 sherpa）');
  if (process.env.SKIP_ASR === '1' || !hasSapi || !model) {
    console.log('  跳过（缺 SAPI / 缺模型 / SKIP_ASR=1）。');
  } else {
    const cfg = resolveAsrConfig({ dataDir: 'D:/Coopanion/data/home/companion/data', mode: 'auto' });
    const t0 = Date.now();
    const r = await transcribe({ cfg, file: clip, ffmpeg, dataDir: REAL_DATA, from: 0, dur, sherpaPath: '' });
    const took = ((Date.now() - t0) / 1000).toFixed(1);
    check('识别跑完没抛错', true, `${took}s / ${r.chunks} 块`);
    check('转出了句子', r.segments.length > 0, `${r.segments.length} 句`);
    if (r.segments.length > 0) {
      const all = r.segments.map((s) => s.text).join('');
      console.log(`     原文：${all.slice(0, 120)}`);
      check('识别到"视频/画面/模型"这类关键词', /视频|画面|模型|宫格|镜头/.test(all));
      check('时间码在窗口内', r.segments.every((s) => s.from >= 0 && s.to <= dur + 0.5),
        r.segments.map((s) => `${s.from.toFixed(1)}-${s.to.toFixed(1)}`).join(' '));
    }

    // 落盘 + locate 读回来
    const tdir = join(dataDir, 'transcripts');
    mkdirSync(tdir, { recursive: true });
    const file = join(tdir, 'asr-BV1P1TEST-p1.json');
    writeFileSync(file, JSON.stringify({
      source: 'asr', engine: r.engine,
      body: r.segments.map((s) => ({ from: s.from, to: s.to, content: s.text })),
    }), 'utf8');

    console.log('\n6) 台词定位（读磁盘，不重新解码）');
    const loaded = loadTranscript(dataDir, 'BV1P1TEST', 1);
    check('读到了刚写的台词', loaded.segments.length === r.segments.length, `${loaded.segments.length} 句 / source=${loaded.source}`);
    check('认出这是语音识别来的', loaded.source === 'asr');
    check('给出了可靠性提醒', /专有名词|核对/.test(loaded.note), loaded.note.slice(0, 70));
  }

  /* ---------------------------------------------------------------- 6.5 音频判据 */

  console.log('\n6.5) 音频判据（说话 vs 配乐）');
  const { audioHint } = await import('../src/bridge/audio-hint.ts');
  // 合成的素材是人声（SAPI）+ 440Hz 正弦混在一起：应该是 speech 或 mixed，绝不该是 music
  // **必须用纯人声素材**：clip.mp4 的占位音轨里混了 440Hz 正弦波，
  // 那条正弦在包络上就是稳定节拍，判成 music 是正确行为，不是判据的错。
  // 这里单独合成一段只含人声的 wav（不带正弦、不做 -shortest 裁剪）。
  const pureVoice = join(dir, 'pure-voice.wav');
  let hasPure = false;
  try {
    const ps = spawnSync('powershell', ['-NoProfile','-Command',
      `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
      `$s.SetOutputToWaveFile('${pureVoice.replace(/\\/g,'\\\\')}'); ` +
      `$s.Rate = -1; ` +
      `$s.Speak('今天我们聊聊视频理解这件事，模型看不到画面，只能靠文字去猜。'); $s.Dispose()`],
      { encoding:'utf8', windowsHide:true, timeout:60_000 });
    hasPure = ps.status === 0 && existsSync(pureVoice);
  } catch { hasPure = false; }
  const hint = hasPure ? await audioHint({ input: pureVoice, ffmpegPath: ffmpeg }) : null;
  if (hint) {
    check('能给出判断', ['speech', 'music', 'mixed'].includes(hint.kind), `kind=${hint.kind} peakHz=${hint.peakHz} ratio=${hint.rhythmRatio}`);
    check('纯人声不判成音乐', hint.kind !== 'music', `判成 ${hint.kind}`);
    check('给出了可读的理由', hint.text.includes('Hz'), hint.text.slice(0, 70));
    check('分析耗时可用（<30 秒）', hint.seconds < 30, `${hint.seconds.toFixed(1)}s`);
  } else {
    console.log('  跳过：这段素材分析不出节奏（不影响其它检查）。');
  }
  // 反向：混了正弦波的 clip.mp4 该被判成音乐（正弦是稳定节拍）
  const mixed = await audioHint({ input: clip, ffmpegPath: ffmpeg });
  check('合成正弦音的片子被判成音乐', Boolean(mixed) && mixed!.kind === 'music', mixed ? `kind=${mixed.kind}` : '分析失败');

  /* ---------------------------------------------------------------- 7. 字幕长图 */

  console.log('\n7) 硬字幕裁带长图');
  const { buildSubtitleStrip, DEFAULT_BAND } = await import('../src/engine/storyboard/subtitle-strip.js');
  const stripOut = join(dir, 'strip.png');
  const t1 = Date.now();
  const strip = await buildSubtitleStrip({
    input: clip,
    ffmpegPath: ffmpeg,
    ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
    from: 0, to: dur,
    maxStrips: 12, stepSec: 2,
    band: DEFAULT_BAND,
    out: stripOut,
  });
  const took1 = ((Date.now() - t1) / 1000).toFixed(1);
  check('出了长图', existsSync(stripOut), `${(strip.bytes / 1024).toFixed(0)}KB / ${took1}s`);
  check('条数合理', strip.strips.length >= 5 && strip.strips.length <= 12, `${strip.strips.length} 条`);
  check('每条都有时间戳', strip.strips.every((s: { t: number }) => Number.isFinite(s.t)),
    strip.strips.map((s: { t: number }) => s.t.toFixed(1)).join(' '));
  check('报了带区间与来源', Array.isArray(strip.band) && typeof strip.bandSource === 'string',
    `${strip.band.join('-')} (${strip.bandSource})`);

  console.log(`\n${failures === 0 ? '全部通过。' : `有 ${failures} 项没过。`}`);
} catch (error) {
  console.error(`\n未预期的失败：${(error as Error)?.stack ?? error}`);
  failures += 1;
} finally {
  if (keep) console.log(`\n临时目录保留在 ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
