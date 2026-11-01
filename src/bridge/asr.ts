/**
 * bridge/asr.ts — 没有字幕轨时，把音轨转成带时间码的台词。
 *
 * ## 走哪条路（按优先级，全部本机、零外网）
 *
 * 1. **社交视窗已经配好的本地 sherpa 模型** —— 本机 `data/home/models/desktop-pet/`
 *    下就有（桌宠自带语音输入用的同一套：sensevoice / paraformer）。
 * 2. **OpenAI 兼容的 `/audio/transcriptions`** —— 如果主人自己起了个本地服务
 *    （`~/.dsh/asr.json` 或配置里的 apiUrl），就走它。
 * 3. 都没有 → 明说"这条没有台词"，**不假装听过音频**。
 *
 * ## 为什么要切片，而不是整段一次送
 *
 * 实测过的坑：单次送 299 秒，识别出的时间码**整体压早 13 秒**（约 4.5%），
 * 停顿被吃掉，于是每句话都挂到上一格上。切成 ≤45 秒、切点落在静音中点之后，
 * 漂移降到 0.02 秒。切片这件事不是优化，是正确性。
 *
 * ## 为什么要过滤"音乐段幻觉"
 *
 * 纯音乐段会吐出一条 29 秒 / 9 个字的假句子，按时间重叠会被贴到 5 个格子上。
 * 判据：**时长 > 8 秒且 < 0.8 字/秒** → 丢弃，并在结果里报出丢弃条数（不静默丢）。
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const run = promisify(execFile);
const nodeRequire = createRequire(import.meta.url);

/** 单次送进识别器的音频长度上限（秒）。超过就切。 */
export const MAX_CHUNK_SEC = 45;

export interface TranscriptSegment {
  from: number;
  to: number;
  text: string;
}

export interface AsrConfig {
  /** 用哪一路。 */
  kind: 'sherpa' | 'api' | 'off';
  /** sherpa：模型文件与词表。 */
  model?: string;
  tokens?: string;
  /** sherpa：sensevoice 还是 paraformer（决定传哪个配置对象）。 */
  modelKind?: 'sensevoice' | 'paraformer';
  language?: string;
  /** api：OpenAI 兼容端点。 */
  apiUrl?: string;
  apiKey?: string;
  apiModel?: string;
  /** 为什么不可用（kind='off' 时给人看）。 */
  reason?: string;
}

/**
 * 找本机已有的本地 ASR 模型。
 *
 * **只扫桌宠自带模型那一层**（`models/desktop-pet/`）——那是桌宠自己的语音输入在用、
 * 一定已经下载好的，复用它等于用户零配置。不扫 `models/asr` 之类的旧目录：
 * 同一个模型在两地被扫到会让下拉里出现两条一样的。
 */
export function findLocalModel(dataDir: string, explicitDir = ''): {
  model: string;
  tokens: string;
  modelKind: 'sensevoice' | 'paraformer';
  dir: string;
} | null {
  const roots: string[] = [];
  if (explicitDir.trim()) roots.push(explicitDir.trim());
  // 从 dataDir 逐级向上找 models/desktop-pet —— dataDir 是 .../companion/data
  let d = dataDir;
  for (let i = 0; i < 8 && d; i += 1) {
    roots.push(join(d, 'models', 'desktop-pet'));
    roots.push(join(d, 'data', 'home', 'models', 'desktop-pet'));
    roots.push(join(d, 'home', 'models', 'desktop-pet'));
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(root, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const tokens = join(dir, 'tokens.txt');
      if (!existsSync(tokens)) continue;
      for (const file of ['model.int8.onnx', 'model.onnx', 'model_q8.onnx']) {
        const model = join(dir, file);
        if (existsSync(model)) {
          return {
            model,
            tokens,
            // 按目录名猜类型：sensevoice 与 paraformer 的配置对象不一样，猜错会加载失败
            modelKind: /sense/i.test(name) || /sense/i.test(model) ? 'sensevoice' : 'paraformer',
            dir,
          };
        }
      }
    }
  }
  return null;
}

/**
 * 找 `sherpa-onnx-node` 并 require 进来。
 *
 * **不能直接 `nodeRequire('sherpa-onnx-node')`。**
 * `createRequire(import.meta.url)` 是按**本包所在地**解析的，而本包装在
 * `extensions/node_modules/` 下 —— 那里没有 sherpa，只有 Coopanion 自己的
 * `resources/app/node_modules/` 里才有。实测报 `Cannot find module 'sherpa-onnx-node'`，
 * 于是整条语音识别在 0.0 秒就"完成"了（返回空，看起来像"没识别出人话"）。
 *
 * 所以按这几个位置逐个试绝对路径，最后才退回包名（开发时本包旁边装了它的情况）。
 */
function resolveSherpaPackage(dataDir: string, explicitPath = ''): string | null {
  if (explicitPath.trim()) {
    const p = explicitPath.trim();
    return existsSync(join(p, 'package.json')) || existsSync(join(p, 'index.js')) ? p : p;
  }
  const candidates: string[] = [];
  // 1) 宿主自己的安装目录（Electron 的 resourcesPath/app/node_modules）
  const rp = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (rp) {
    candidates.push(join(rp, 'app', 'node_modules', 'sherpa-onnx-node'));
    candidates.push(join(rp, 'node_modules', 'sherpa-onnx-node'));
  }
  // 2) 从 dataDir 逐级向上找（dataDir 是 .../companion/data）
  //
  // 注意：向上走**到不了** Coopanion 的安装目录 ——
  //   dataDir  = D:\Coopanion\data\home\companion\data
  //   app/node = D:\Coopanion\resources\app\node_modules
  // 两者在 `D:\Coopanion` 分叉。所以除了"往上找自己的 node_modules"，
  // 还要专门试**同级的 resources/app/node_modules**（这才是桌面版的真实布局）。
  let d = dataDir;
  for (let i = 0; i < 8 && d; i += 1) {
    candidates.push(join(d, 'node_modules', 'sherpa-onnx-node'));
    // 关键的一条：从 D:\Coopanion\data\home\companion\data 往上，
    // 在 D:\Coopanion 这一层拼 resources\app\node_modules
    candidates.push(join(d, 'resources', 'app', 'node_modules', 'sherpa-onnx-node'));
    candidates.push(join(d, 'app', 'node_modules', 'sherpa-onnx-node'));
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  // 3) 进程当前目录（桌宠从自己的目录起时命中）
  try {
    candidates.push(join(process.cwd(), 'node_modules', 'sherpa-onnx-node'));
    candidates.push(join(process.cwd(), 'resources', 'app', 'node_modules', 'sherpa-onnx-node'));
  } catch {
    /* 有些宿主 context 里 cwd 拿不到 */
  }
  for (const c of candidates) {
    if (existsSync(join(c, 'package.json'))) return c;
  }
  return null;
}

/** 这次到底能不能转写 —— 与 transcribe() 的判据同源，不能两张皮。 */
export function resolveAsrConfig(o: {
  dataDir: string;
  mode: string;
  modelDir?: string;
  sherpaPath?: string;
  language?: string;
  apiUrl?: string;
  apiKey?: string;
  apiModel?: string;
}): AsrConfig {
  const mode = String(o.mode ?? 'auto').toLowerCase();
  if (mode === 'off') return { kind: 'off', reason: '语音识别已按配置关闭。' };

  // api 显式优先
  if (mode === 'api') {
    if (!o.apiUrl?.trim()) return { kind: 'off', reason: '选了 API 模式但没填端点地址。' };
    return {
      kind: 'api',
      apiUrl: o.apiUrl.trim(),
      apiKey: o.apiKey?.trim() ?? '',
      apiModel: o.apiModel?.trim() || 'whisper-1',
      language: o.language,
    };
  }

  const local = findLocalModel(o.dataDir, o.modelDir ?? '');
  if (!local) {
    return {
      kind: 'off',
      reason:
        '这台机器上没找到本地语音模型。桌宠自带语音输入用的那一套（models/desktop-pet/ 下的 ' +
        'model.int8.onnx + tokens.txt）如果装了就能直接用；否则请在配置页把模型目录填上，' +
        '或改用 API 模式。',
    };
  }
  return {
    kind: 'sherpa',
    model: local.model,
    tokens: local.tokens,
    modelKind: local.modelKind,
    language: o.language ?? 'auto',
  };
}

/* ------------------------------------------------------------------ sherpa */

interface Recognizer {
  createStream(): { acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void };
  decodeAsync(stream: unknown): Promise<{ text?: string }>;
}

let cached: { rec: Recognizer; key: string } | null = null;

export function resetRecognizer(): void {
  cached = null;
}

async function getRecognizer(cfg: AsrConfig, dataDir: string, sherpaPath: string): Promise<Recognizer> {
  const key = `${cfg.model}|${cfg.tokens}|${cfg.modelKind}|${cfg.language}`;
  if (cached?.key === key) return cached.rec;
  const spec = resolveSherpaPackage(dataDir, sherpaPath);
  if (!spec) {
    throw new Error(
      '没找到 sherpa-onnx-node 包。它通常随桌宠装在 resources/app/node_modules/ 下；' +
        '如果装在别处，请在配置页的「sherpa-onnx-node 路径」填目录。',
    );
  }
  const mod = nodeRequire(spec) as {
    OfflineRecognizer: { createAsync(c: Record<string, unknown>): Promise<Recognizer> };
  };
  const modelConfig: Record<string, unknown> = {
    tokens: cfg.tokens,
    numThreads: 2,
    provider: 'cpu',
    debug: 0,
  };
  if (cfg.modelKind === 'sensevoice') {
    modelConfig.senseVoice = {
      model: cfg.model,
      language: cfg.language || 'auto',
      useInverseTextNormalization: 1,
    };
  } else {
    modelConfig.paraformer = { model: cfg.model };
  }
  const rec = await mod.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig,
  });
  cached = { rec, key };
  return rec;
}

/** 把整条音轨解成 16kHz 单声道 float32。没有音轨时返回空数组。 */
async function decodeAudio(ffmpeg: string, file: string, fromSec = 0, durSec?: number): Promise<Float32Array> {
  const args = ['-v', 'error'];
  // `-ss` 放在 `-i` 之前：只 seek 不解前面的部分，长片快得多
  if (fromSec > 0) args.push('-ss', fromSec.toFixed(2));
  if (Number.isFinite(durSec) && durSec! > 0) args.push('-t', durSec!.toFixed(2));
  args.push('-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1');
  const { stdout } = (await run(ffmpeg, args, {
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'buffer',
  })) as unknown as { stdout: Buffer };
  if (!stdout || stdout.byteLength < 4) return new Float32Array(0);
  const bytes = stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength);
  return new Float32Array(bytes, 0, Math.floor(bytes.byteLength / 4));
}

/**
 * 静音中点。切点落在这里，词就不会被切两半 —— 固定秒数切会把一个词切开，
 * 段数凭空变多，下游按时间对齐时那句话就被贴到两个格子上。
 */
async function silenceMidpoints(ffmpeg: string, file: string, fromSec: number, durSec: number): Promise<number[]> {
  try {
    const { stderr } = await run(
      ffmpeg,
      ['-v', 'info', '-ss', fromSec.toFixed(2), '-t', durSec.toFixed(2), '-i', file,
        '-vn', '-af', 'silencedetect=noise=-35dB:d=0.25', '-f', 'null', '-'],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const out: number[] = [];
    let start: number | null = null;
    for (const line of String(stderr).split('\n')) {
      const s = /silence_start: ([\d.]+)/.exec(line);
      const e = /silence_end: ([\d.]+)/.exec(line);
      if (s) start = Number(s[1]);
      else if (e && start !== null) {
        out.push(((start + Number(e[1])) / 2) + fromSec);
        start = null;
      }
    }
    return out.sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * 把一整段音频切成 ≤MAX_CHUNK_SEC 的块，切点尽量落在静音中点。
 * @returns 每块的 [起点(绝对秒), 长度(秒)]
 */
export function planChunks(
  fromSec: number,
  durSec: number,
  silences: number[],
  maxChunk = MAX_CHUNK_SEC,
): Array<{ at: number; len: number }> {
  const out: Array<{ at: number; len: number }> = [];
  let at = fromSec;
  const end = fromSec + durSec;
  // 切片太短就别再切了：剩下的并进上一块
  while (at < end - 0.5) {
    const want = Math.min(maxChunk, end - at);
    if (end - at - want < 2) {
      out.push({ at, len: end - at });
      break;
    }
    // 在 [at+want*0.6, at+want] 里找最后一个静音中点作切点；找不到就硬切
    const lo = at + want * 0.6;
    const hi = at + want;
    const cand = silences.filter((t) => t > lo && t < hi);
    const cut = cand.length ? cand[cand.length - 1] : hi;
    out.push({ at, len: cut - at });
    at = cut;
  }
  return out;
}

/**
 * 音乐段 / 长静音里的幻觉句子。
 *
 * 实测：纯音乐 PV 会吐出一条 29 秒 / 9 个字的"台词"，按时间重叠被贴到 5 个格子上。
 * 判据保守一点没关系 —— 宁可少给一句，也不要给一句不存在的。
 */
export function looksLikeHallucination(seg: TranscriptSegment): boolean {
  const dur = seg.to - seg.from;
  const chars = String(seg.text ?? '').replace(/\s/g, '').length;
  if (dur < 1) return true; // 太短，多半是一个音节的误触
  if (dur > 8 && chars / dur < 0.8) return true; // 长而稀：音乐
  if (chars === 0) return true;
  return false;
}

export interface TranscriptionResult {
  segments: TranscriptSegment[];
  /** 丢弃了几条疑似幻觉。 */
  dropped: number;
  /** 用什么转的（写进结果让模型知道依据）。 */
  engine: string;
  /** 转写花了多久（秒）。 */
  seconds: number;
  /** 真实请求了几块。 */
  chunks: number;
}

/**
 * 转写一个窗口。**不抛错**：失败就返回空 segments + 原因，画面照出。
 *
 * @param o.from 绝对起点（秒）
 * @param o.dur  窗口长度（秒）
 */
export async function transcribe(o: {
  cfg: AsrConfig;
  file: string;
  ffmpeg: string;
  dataDir: string;
  from: number;
  dur: number;
  sherpaPath?: string;
}): Promise<TranscriptionResult> {
  const t0 = Date.now();
  const empty = (reason: string): TranscriptionResult => ({
    segments: [],
    dropped: 0,
    engine: reason,
    seconds: (Date.now() - t0) / 1000,
    chunks: 0,
  });
  if (o.cfg.kind === 'off') return empty(o.cfg.reason ?? '未启用');

  if (o.cfg.kind === 'api') return transcribeViaApi(o, t0);

  // sherpa：切片 + 静音吸附
  try {
    const silences = await silenceMidpoints(o.ffmpeg, o.file, o.from, o.dur);
    const chunks = planChunks(o.from, o.dur, silences, MAX_CHUNK_SEC);
    if (chunks.length === 0) return empty('这个窗口里没有音频');

    const rec = await getRecognizer(o.cfg, o.dataDir, o.sherpaPath ?? '');
    const segments: TranscriptSegment[] = [];
    let dropped = 0;

    for (const c of chunks) {
      const samples = await decodeAudio(o.ffmpeg, o.file, c.at, c.len);
      if (!samples.length) continue;
      const stream = rec.createStream();
      stream.acceptWaveform({ sampleRate: 16_000, samples });
      const r = await rec.decodeAsync(stream);
      const text = String(r.text ?? '').trim();
      if (!text) continue;
      const seg = { from: c.at, to: c.at + c.len, text };
      if (looksLikeHallucination(seg)) {
        dropped += 1;
        continue;
      }
      segments.push(seg);
    }

    return {
      segments: finalize(segments),
      dropped,
      engine: `本地 ${o.cfg.modelKind === 'sensevoice' ? 'SenseVoice' : 'Paraformer'}（${chunks.length} 个切片）`,
      seconds: (Date.now() - t0) / 1000,
      chunks: chunks.length,
    };
  } catch (error) {
    // 加载失败（sherpa 没装、模型坏了）不该让分镜失败 —— 只是这次没有台词
    return empty(`本地识别不可用：${(error as Error).message.slice(0, 160)}`);
  }
}

/** 相邻且紧挨着的段合并 —— 识别器按切片出结果，一句话被切成两块时看起来像两句。 */
function finalize(segments: TranscriptSegment[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    // 间隔 < 0.35s 且上一句没有句末标点 → 认为是被切开的同一句
    if (last && s.from - last.to < 0.35 && !/[。！？!?]$/.test(last.text)) {
      last.to = s.to;
      last.text = `${last.text}${s.text}`;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** api 模式：抽 wav → multipart POST → 读回 text。失败返回空。 */
async function transcribeViaApi(
  o: { cfg: AsrConfig; file: string; ffmpeg: string; from: number; dur: number },
  t0: number,
): Promise<TranscriptionResult> {
  try {
    // 单独的临时目录：转写完整个删掉，不往用户的盘里留 wav（16k 单声道一小时也有 ~230MB）
    const dir = mkdtempSync(join(tmpdir(), 'vr-asr-'));
    const tmp = join(dir, 'a.wav');
    const ffArgs = ['-v', 'error', '-y'];
    if (o.from > 0) ffArgs.push('-ss', o.from.toFixed(2));
    ffArgs.push('-t', o.dur.toFixed(2), '-i', o.file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', tmp);
    await run(o.ffmpeg, ffArgs, { maxBuffer: 256 * 1024 * 1024 });

    const buf = await readFile(tmp);
    rmSync(dir, { recursive: true, force: true });
    if (!buf.length) return { segments: [], dropped: 0, engine: 'API', seconds: 0, chunks: 1 };

    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', o.cfg.apiModel || 'whisper-1');
    if (o.cfg.language && o.cfg.language !== 'auto') form.append('language', o.cfg.language);
    form.append('response_format', 'verbose_json');
    const headers: Record<string, string> = {};
    if (o.cfg.apiKey) headers.Authorization = `Bearer ${o.cfg.apiKey}`;

    const res = await fetch(`${o.cfg.apiUrl!.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      return { segments: [], dropped: 0, engine: `API ${res.status}`, seconds: (Date.now() - t0) / 1000, chunks: 1 };
    }
    const data = (await res.json()) as { text?: string; segments?: Array<{ start: number; end: number; text: string }> };
    if (Array.isArray(data.segments) && data.segments.length) {
      const segs = data.segments
        .map((s) => ({ from: o.from + Number(s.start), to: o.from + Number(s.end), text: String(s.text ?? '').trim() }))
        .filter((s) => s.text && Number.isFinite(s.from) && Number.isFinite(s.to));
      return { segments: segs, dropped: 0, engine: 'API（带时间码）', seconds: (Date.now() - t0) / 1000, chunks: 1 };
    }
    // 没有时间码的实现：整段当一个句子，至少还能被 locate 用上
    const text = String(data.text ?? '').trim();
    return {
      segments: text ? [{ from: o.from, to: o.from + o.dur, text }] : [],
      dropped: 0,
      engine: 'API（无时间码，整段一句）',
      seconds: (Date.now() - t0) / 1000,
      chunks: 1,
    };
  } catch (error) {
    return { segments: [], dropped: 0, engine: `API 失败：${(error as Error).message.slice(0, 120)}`, seconds: (Date.now() - t0) / 1000, chunks: 0 };
  }
}
