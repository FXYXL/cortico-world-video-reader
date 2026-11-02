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

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Engine } from '../engine/load.js';
import { BiliError, BilibiliClient, type BiliMeta, type PlayInfo } from './bilibili.js';
import { transcribe, type AsrConfig, type TranscriptSegment } from './asr.js';

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
  /** 显式指定的转写文件，给了就跳过字幕接口，也跳过 ASR。 */
  transcriptFile?: string;
  /**
   * 没有字幕轨时用哪一路语音识别。`undefined` 或 `kind:'off'` = 不转写
   * （结果里会说明原因，不会假装听过音频）。
   */
  asr?: AsrConfig;
  /** 覆盖 `sherpa-onnx-node` 的解析路径。 */
  asrSherpaPath?: string;
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
    /**
     * **失败时重取一次直链。**
     *
     * B站的播放地址带签名，有效期约 2 小时；而且 `playurl` 返回的 CDN 域名会变。
     * 实测踩过：一次下载失败，回执里是
     * `Error opening input file https://…mcdn.bilivideo.cn:8082/…` —— 那条直链打不开了。
     * 只重试同一个 URL 必然还是失败（签名过期或该 CDN 节点挂了），
     * 而重新调一次 `playurl` 就能拿到新签名/新节点。
     *
     * 所以这里试两轮：第二轮**重新取流**再下。两轮都失败就把最终原因抛出去
     * （原因里不该带 URL —— 见 `explainFfmpegStderr`）。
     */
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const fresh = attempt === 1 ? play : await client.playurl(meta, height, o.signal);
        const merged = await client.download(fresh, localPath, o.ffmpeg, {
          signal: o.signal,
          durationSec: meta.partDuration || meta.duration,
        });
        downloaded = true;
        hasAudio = merged.hasAudio;
        break;
      } catch (error) {
        // 第一轮失败先把半成品清掉：留下 0 字节或半个文件会让下一轮"看起来命中了缓存"
        try {
          if (existsSync(localPath) && statSync(localPath).size === 0) rmSync(localPath, { force: true });
        } catch {
          /* 删不掉就算了 */
        }
        if (attempt === 2) throw error;
      }
    }
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

  const { file, note } = await ensureTranscript(o, meta, localPath);

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
  localPath: string,
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
    // 字幕接口挂了不代表没有台词：还有 ASR 这条路。
    return await ensureAfterSubtitleMiss(o, meta, localPath, `字幕接口未响应：${(error as Error).message}`);
  }
  if (!info.available || !info.raw) {
    // **没有字幕轨 → 退回 ASR**。这是 P1 补的那条路：
    // 没字幕的视频以前只能看画面，现在能读到说的话（前提是本机有模型）。
    //
    // `ensureAfterSubtitleMiss` **永远**返回一个对象（哪怕 file 为 null），
    // 它的 note 才是"为什么没有台词"的权威说明 —— 外面再包一层
    // `没有字幕：${info.reason}` 会把"跑了识别但没听到人话"抹成"没有字幕"，
    // 正是那种"结果说不清为什么、用户以为是插件坏了"的毛病。
    return await ensureAfterSubtitleMiss(o, meta, localPath, info.reason);
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

/* ------------------------------------------------------------------ ASR 兜底 */

/**
 * 没有字幕轨时的兜底：本地 ASR。
 *
 * **永远返回一个带 note 的结果**（file 可以是 null）—— 它的 note 是"为什么没有台词"
 * 的唯一权威说明，调用方不要再包一层"没有字幕"。三种情况必须能被区分开：
 *   1. 站点字幕：取不到（`siteReason` 里是站点的原话）
 *   2. 识别跑了但没人说话 → "跑了 4 个切片，丢弃 4 条疑似音乐段幻觉"
 *   3. 识别根本没法用（没模型 / 没装 sherpa）→ 给出怎么装
 * 第三种以前会被静默成第一种，用户看到"没有字幕"却不知道插件到底试没试过。
 */
async function ensureAfterSubtitleMiss(
  o: ResolveOptions,
  meta: BiliMeta,
  localPath: string,
  siteReason = '',
): Promise<{ file: string | null; note: string }> {
  const cfg = o.asr;
  // 站点的原话常自带句号（"这个视频没有字幕轨。"），再补一个就是 "。。"
  const siteMissed = siteReason ? `站点这边：${siteReason.replace(/[。.]\s*$/, '')}。` : '';
  if (!cfg || cfg.kind === 'off') {
    // 说清"为什么没有台词"，而不是只说"没有"
    return {
      file: null,
      note: `没有字幕轨。${siteMissed}${cfg?.reason ? `语音识别也没启用：${cfg.reason}` : '语音识别也没启用'}，所以没有台词。`,
    };
  }
  if (!existsSync(localPath)) {
    return {
      file: null,
      note: `没有字幕轨。${siteMissed}本地副本还没落盘，这次没法做语音识别，所以没有台词。`,
    };
  }

  const dir = transcriptDir(o.dataDir);
  const file = join(dir, `asr-${meta.bvid}-p${meta.part}.json`);
  if (existsSync(file) && statSync(file).size > 8) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as { segments?: TranscriptSegment[]; engine?: string };
      const n = cached.segments?.length ?? 0;
      if (n > 0) {
        return { file, note: `没有站点字幕，用的是本地语音识别（已缓存，${n} 句）。` };
      }
    } catch {
      // 坏文件：重新转一遍
    }
  }

  const duration = meta.partDuration || meta.duration || 0;
  if (!duration) {
    return { file: null, note: `没有字幕轨。${siteMissed}读不到时长，这次没法做语音识别，所以没有台词。` };
  }

  const result = await transcribe({
    cfg,
    file: localPath,
    ffmpeg: o.ffmpeg,
    dataDir: o.dataDir,
    from: 0,
    dur: duration,
    sherpaPath: o.asrSherpaPath,
  });

  if (result.segments.length === 0) {
    return {
      file: null,
      note:
        `没有字幕轨。${siteMissed}语音识别跑了 ${result.chunks} 个切片（${result.seconds.toFixed(0)} 秒）但没听到人话（${result.engine}），` +
        (result.dropped > 0 ? `丢弃了 ${result.dropped} 条疑似音乐段幻觉。` : '这一段可能没有人声。') +
        '所以只能看画面 —— 不要据此认为这条视频没有内容，只是没有可读的台词。',
    };
  }

  try {
    mkdirSync(dir, { recursive: true });
    // 存成引擎认得的 {body:[{from,to,content}]} —— 和 B站字幕同一个格式，
    // 下游 transcript-file 不用区分这行字是站点给的还是自己转的。
    writeFileSync(
      file,
      JSON.stringify({
        source: 'asr',
        engine: result.engine,
        body: result.segments.map((s) => ({ from: s.from, to: s.to, content: s.text })),
      }),
      'utf8',
    );
    const chars = result.segments.reduce((n, s) => n + s.text.length, 0);
    return {
      file,
      note:
        `没有字幕轨。${siteMissed}用本地语音识别转写了 ${result.chunks} 个切片（${result.seconds.toFixed(0)} 秒，` +
        `${chars} 字，${result.segments.length} 句）` +
        (result.dropped > 0 ? `，丢弃 ${result.dropped} 条疑似音乐段幻觉` : '') +
        '。引用前建议对画面核对专有名词。',
    };
  } catch (error) {
    return { file: null, note: `语音识别成功但写入失败：${(error as Error).message}` };
  }
}

/* ------------------------------------------------------------------ 本地 */

async function resolveLocal(o: ResolveOptions, raw: string): Promise<PreparedSource> {
  const path = raw;
  if (!existsSync(path)) throw new BiliError(`找不到文件：${path}`);
  const st = statSync(path);
  if (!st.isFile()) throw new BiliError(`不是文件：${path}`);
  if (st.size === 0) throw new BiliError(`文件是空的：${path}`);

  const explicit = o.transcriptFile && existsSync(o.transcriptFile) ? o.transcriptFile : null;
  const local: PreparedSource = {
    kind: 'local',
    identity: path,
    title: path.split(/[\\/]/).pop() ?? path,
    localPath: path,
    meta: null,
    play: null,
    transcriptFile: explicit,
    transcriptNote: explicit ? `使用指定转写：${explicit}` : '',
    frameSource: null,
    downloaded: false,
    hasAudio: null,
    degraded: [],
  };
  if (!explicit) {
    // 本地文件没有"站点字幕"这个概念 —— 直接走语音识别（如果启用了）。
    const cfg = o.asr;
    if (cfg && cfg.kind !== 'off' && existsSync(local.localPath)) {
      const info = await o.engine.probeVideo(local.localPath, { ffprobePath: o.ffprobe }).catch(() => null);
      const duration = Number(info?.duration) || 0;
      if (Number(info?.hasAudio) && duration > 0) {
        const result = await transcribe({
          cfg,
          file: local.localPath,
          ffmpeg: o.ffmpeg,
          dataDir: o.dataDir,
          from: 0,
          dur: duration,
          sherpaPath: o.asrSherpaPath,
        });
        if (result.segments.length > 0) {
          const dir = transcriptDir(o.dataDir);
          mkdirSync(dir, { recursive: true });
          const f = join(dir, `asr-local-${st.size}-${Math.round(st.mtimeMs)}.json`);
          writeFileSync(
            f,
            JSON.stringify({
              source: 'asr',
              engine: result.engine,
              body: result.segments.map((s) => ({ from: s.from, to: s.to, content: s.text })),
            }),
            'utf8',
          );
          local.transcriptFile = f;
          local.transcriptNote =
            `本地文件没有字幕轨，用语音识别转写了 ${result.chunks} 个切片（${result.seconds.toFixed(0)} 秒，` +
            `${result.segments.length} 句）` +
            (result.dropped > 0 ? `，丢弃 ${result.dropped} 条疑似音乐段幻觉` : '') +
            '。引用前建议对画面核对专有名词。';
        } else {
          local.transcriptNote = `本地文件没有字幕轨；语音识别跑完了但没识别出人话（${result.engine}），所以只能看画面。`;
        }
      } else {
        local.transcriptNote = '这个文件没有音轨，所以没有台词；只能看画面。';
      }
    } else if (cfg && cfg.kind === 'off') {
      local.transcriptNote = `没有字幕轨，${cfg.reason ?? '语音识别也没启用'}，所以没有台词。`;
    } else {
      local.transcriptNote = '本地文件没有字幕轨。把视频连同字幕文件（SRT）一起给，或者启用语音识别。';
    }
  } else {
    local.transcriptNote = `使用指定转写：${explicit}`;
  }
  return local;
}
