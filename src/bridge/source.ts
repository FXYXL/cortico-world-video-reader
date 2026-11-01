/**
 * bridge/source.ts — 「模型给了个编号/链接/路径」→「本地有一份能喂给引擎的文件」。
 *
 * ## 为什么落盘路径必须**确定性**
 *
 * 引擎有三处按输入字符串记账：
 *   1. 扫描缓存（键含文件路径）
 *   2. `cells.json` —— `video_zoom({cellId})` 靠它把"第 7 格"还原成绝对时间
 *   3. 媒体 LRU
 * 如果每次调用落到临时文件名，第 2 条必然查不到，模型就只能自己抄时间码（然后抄错）。
 * 所以路径由「BV + 分P + 清晰度」推导，换机器/换时段都一致。
 *
 * 落盘位置直接用**引擎自己的媒体缓存目录**（`DSH_VIDEO_MEDIA_DIR`），
 * 于是容量淘汰、磁盘余量检查这些不用重写一份。
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Engine } from '../engine/load.js';
import { BiliError, BilibiliClient, type BiliMeta, type PlayInfo } from './bilibili.js';

export interface FrameSource {
  uri: string;
  userAgent: string;
  referer: string;
  height: number;
}

export interface PreparedSource {
  kind: 'bilibili' | 'local';
  /** 交给 cells.json 与扫描缓存的稳定标识。 */
  identity: string;
  /** 给人看的名字（标题/文件名）。 */
  title: string;
  localPath: string;
  meta: BiliMeta | null;
  play: PlayInfo | null;
  /** 可直接喂给引擎 `transcriptFile` 的字幕文件；没有就是 null。 */
  transcriptFile: string | null;
  /** 字幕为什么没有/用的哪一路，写进结果让模型别瞎猜。 */
  transcriptNote: string;
  frameSource: FrameSource | null;
  /** 这次是新下载的，还是命中缓存。 */
  downloaded: boolean;
  hasAudio: boolean | null;
  /** 清晰度/登录一类的降级说明。 */
  degraded: string[];
}

export interface ResolveOptions {
  input: string;
  part: number;
  /** 想要多清晰（B站是上限，本地文件无关）。 */
  height: number;
  /** 要不要顺带准备一份高清直链（zoom 用）。 */
  wantFrameSource: boolean;
  frameHeight: number;
  client: BilibiliClient;
  engine: Engine;
  dataDir: string;
  ffmpeg: string;
  ffprobe: string;
  signal?: AbortSignal;
  /** 显式指定的转写文件，给了就跳过字幕接口。 */
  transcriptFile?: string;
}

const isHttp = (v: string) => /^https?:\/\//i.test(v);
const isBili = (v: string) =>
  /bilibili\.com/i.test(v) || /^(BV[0-9A-Za-z]{10}|av\d{1,20})$/i.test(v.trim());

function transcriptDir(dataDir: string): string {
  return join(dataDir, 'transcripts');
}

export async function resolveSource(o: ResolveOptions): Promise<PreparedSource> {
  const raw = String(o.input ?? '').trim().replace(/^"|"$/g, '');
  if (!raw) throw new BiliError('没给视频：填 B站 BV 号 / av 号 / 完整链接，或本地绝对路径。');

  if (isBili(raw) || (isHttp(raw) && !isBili(raw))) {
    if (isHttp(raw) && !isBili(raw)) {
      throw new BiliError(
        '目前只支持 B站链接和本地文件。其它站点请先把视频下载到本地，再把绝对路径给它。',
        'invalid',
      );
    }
    return resolveBilibili(o, raw);
  }
  return resolveLocal(o, raw);
}

/* ------------------------------------------------------------------ B站 */

async function resolveBilibili(o: ResolveOptions, raw: string): Promise<PreparedSource> {
  const { client, engine, height } = o;
  const meta = await client.view(raw, o.part, o.signal);
  const play = await client.playurl(meta, height, o.signal);

  const identity = `bilibili:${meta.bvid}:p${meta.part}`;
  const key = engine.mediaKey(`${identity}@${height}`, height);
  const dir = join(engine.mediaDir(), key);
  const localPath = join(dir, 'video.mp4');

  let downloaded = false;
  let hasAudio: boolean | null = null;
  if (!existsSync(localPath) || statSync(localPath).size === 0) {
    mkdirSync(dir, { recursive: true });
    const merged = await client.download(play, localPath, o.ffmpeg, { signal: o.signal });
    downloaded = true;
    hasAudio = merged.hasAudio;
    // 落一份 meta：出问题时不用重新调接口就能对上"当时拿到的是哪一档"
    try {
      writeFileSync(
        join(dir, 'meta.json'),
        JSON.stringify({ identity, height, got: play.height, at: new Date().toISOString(), title: meta.title }, null, 0),
        'utf8',
      );
    } catch {
      /* 写不了就算了，不影响播放 */
    }
  } else {
    try {
      const info = await engine.probeVideo(localPath, { ffprobePath: o.ffprobe }).catch(() => null);
      hasAudio = info ? Boolean(info.hasAudio) : null;
    } catch {
      hasAudio = null;
    }
  }

  // 缓存维护：跟引擎自己的淘汰策略走（超预算删最久没用的）
  try {
    await engine.pruneMedia({ dir: engine.mediaDir(), maxBytes: engine.mediaMaxBytes() });
  } catch {
    /* 淘汰失败不该让这次读取失败 */
  }

  const { file, note } = await ensureTranscript(o, meta);

  const frameSource = o.wantFrameSource
    ? await client.frameSource(meta, o.frameHeight, o.signal)
    : null;

  return {
    kind: 'bilibili',
    identity,
    title: meta.title || `${meta.bvid} p${meta.part}`,
    localPath,
    meta,
    play,
    transcriptFile: file,
    transcriptNote: note,
    frameSource,
    downloaded,
    hasAudio,
    degraded: [...play.degraded],
  };
}

/** 字幕：先看本地缓存，没有再调接口。缓存按 BV+分P 存，换清晰度不用重取。 */
async function ensureTranscript(
  o: ResolveOptions,
  meta: BiliMeta,
): Promise<{ file: string | null; note: string }> {
  if (o.transcriptFile) {
    return existsSync(o.transcriptFile)
      ? { file: o.transcriptFile, note: `使用指定转写：${o.transcriptFile}` }
      : { file: null, note: `指定的转写文件不存在：${o.transcriptFile}` };
  }
  const dir = transcriptDir(o.dataDir);
  const file = join(dir, `${meta.bvid}-p${meta.part}.json`);
  if (existsSync(file) && statSync(file).size > 8) {
    return { file, note: '字幕来自 B站字幕轨（已缓存）。' };
  }
  let info;
  try {
    info = await o.client.subtitles(meta, o.signal);
  } catch (error) {
    return { file: null, note: `字幕未取到：${(error as Error).message}` };
  }
  if (!info.available || !info.raw) {
    return { file: null, note: `没有字幕：${info.reason ?? '未知原因'}` };
  }
  try {
    mkdirSync(dir, { recursive: true });
    // 原样存 B站 JSON（{body:[{from,to,content}]}）—— 引擎的 transcript-file 原生认这个格式
    writeFileSync(file, JSON.stringify(info.raw), 'utf8');
    return {
      file,
      note: `字幕来自 B站字幕轨${info.langDoc ? `（${info.langDoc}）` : ''}，共 ${info.segments.length} 句。`,
    };
  } catch (error) {
    return { file: null, note: `字幕写入失败：${(error as Error).message}` };
  }
}

/* ------------------------------------------------------------------ 本地 */

async function resolveLocal(o: ResolveOptions, raw: string): Promise<PreparedSource> {
  const path = raw;
  if (!existsSync(path)) throw new BiliError(`找不到文件：${path}`);
  const st = statSync(path);
  if (!st.isFile()) throw new BiliError(`不是文件：${path}`);
  if (st.size === 0) throw new BiliError(`文件是空的：${path}`);

  const file = o.transcriptFile && existsSync(o.transcriptFile) ? o.transcriptFile : null;
  return {
    kind: 'local',
    identity: path,
    title: path.split(/[\\/]/).pop() ?? path,
    localPath: path,
    meta: null,
    play: null,
    transcriptFile: file,
    transcriptNote: file ? `使用指定转写：${file}` : '本地文件没有字幕轨时不会自动转写（V1 未接 ASR）。',
    frameSource: null,
    downloaded: false,
    hasAudio: null,
    degraded: [],
  };
}
