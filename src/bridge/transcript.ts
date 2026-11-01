/**
 * bridge/transcript.ts — 「这条视频的台词在哪」。
 *
 * `video_storyboard` 跑完之后，台词已经落在 `<dataDir>/transcripts/` 里了
 * （站点字幕 `BV…-p…json`，或我们转的 `asr-BV…-p…json`）。
 * `video_locate` 直接读这份文件，**不解码、不出图、不花图片 token**。
 *
 * 为什么不复用引擎里那个 `locate.js` 的进程内缓存：那是给"storyboard 紧接着 zoom"
 * 设计的，只活 4 条、且宿主重启就没了。而模型的真实用法是**隔几轮才回头问
 * "那句话在第几分钟"** —— 这时进程内缓存早没了，但磁盘上那份字幕还在。
 * 所以这里读磁盘，匹配逻辑仍用引擎的（见 `gone() `下面的说明）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Segment {
  from: number;
  to: number;
  text: string;
}

export interface LoadedTranscript {
  /** 从哪来的，写进结果让模型知道依据的可靠程度。 */
  source: 'site-subtitle' | 'asr' | 'file' | 'none';
  segments: Segment[];
  /** 站点字幕的语言（有的话）。 */
  lang?: string;
  /** 转写引擎（ASR 时）。 */
  engine?: string;
  note: string;
}

/** 这条视频可能有的两个字幕文件名（站点字幕优先——作者写的比识别准）。 */
export function transcriptCandidates(dataDir: string, bvid: string, part: number): string[] {
  const dir = join(dataDir, 'transcripts');
  return [join(dir, `${bvid}-p${part}.json`), join(dir, `asr-${bvid}-p${part}.json`)];
}

/**
 * 读一条视频的台词。**不会现场转写** —— 那是 storyboard 的事。
 * 没有就明说"还没读过这条"，并给出下一步该调什么。
 */
export function loadTranscript(dataDir: string, bvid: string, part: number, explicitFile?: string): LoadedTranscript {
  if (explicitFile) {
    if (!existsSync(explicitFile)) {
      return { source: 'none', segments: [], note: `指定的转写文件不存在：${explicitFile}` };
    }
    const segments = parseAny(explicitFile);
    return {
      source: segments.length ? 'file' : 'none',
      segments,
      note: segments.length
        ? `使用指定转写：${explicitFile}（${segments.length} 句）`
        : `指定的文件里没解析出带时间码的句子：${explicitFile}`,
    };
  }

  for (const [i, file] of transcriptCandidates(dataDir, bvid, part).entries()) {
    if (!existsSync(file) || statSync(file).size < 8) continue;
    const parsed = parseFile(file);
    if (!parsed || parsed.segments.length === 0) continue;
    const isAsr = i === 1;
    return {
      source: isAsr ? 'asr' : 'site-subtitle',
      segments: parsed.segments,
      lang: parsed.lang,
      engine: parsed.engine,
      note: isAsr
        ? `语音识别（${parsed.engine ?? '未知引擎'}），${parsed.segments.length} 句。专有名词可能识别错，引用前建议对画面核对。`
        : `站点字幕轨${parsed.lang ? `（${parsed.lang}）` : ''}，${parsed.segments.length} 句。`,
    };
  }

  return {
    source: 'none',
    segments: [],
    note:
      `这条视频还没有台词可用（${bvid} p${part}）。` +
      '先调 video_storyboard 读一次，它会把字幕轨（或必要时本地语音识别）落到本地；' +
      '之后再 locate 就不用重新解码了。',
  };
}

/** B站的字幕 JSON 是 `{body:[{from,to,content}]}`；我们转的是同一个形状但多了 source/engine。 */
function parseFile(file: string): { segments: Segment[]; lang?: string; engine?: string } | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const body = Array.isArray(raw.body) ? (raw.body as Record<string, unknown>[]) : null;
    if (!body) return null;
    const segments: Segment[] = [];
    for (const item of body) {
      const from = Number(item.from ?? item.start);
      const to = Number(item.to ?? item.end);
      const text = String(item.content ?? item.text ?? '').trim();
      if (!text || !Number.isFinite(from) || !Number.isFinite(to)) continue;
      segments.push({ from, to: Math.max(to, from), text });
    }
    return {
      segments: segments.sort((a, b) => a.from - b.from),
      ...(typeof raw.language === 'string' ? { lang: raw.language } : {}),
      ...(typeof raw.engine === 'string' ? { engine: raw.engine } : {}),
    };
  } catch {
    return null;
  }
}

/** 用户自己给的文件：SRT 或 JSON 都认（复用引擎的解析器，逻辑一致）。 */
function parseAny(file: string): Segment[] {
  const parsed = parseFile(file);
  if (parsed) return parsed.segments;
  // SRT：引擎的 transcript-file.js 有一份成熟的解析（容忍 BOM/CRLF/多行/坐标后缀）
  try {
    const text = readFileSync(file, 'utf8');
    return parseSrtLite(text);
  } catch {
    return [];
  }
}

/** 最小可用的 SRT 解析：只给"用户自己递进来的文件"兜底用。 */
function parseSrtLite(text: string): Segment[] {
  const out: Segment[] = [];
  for (const block of text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const arrowAt = block.split('\n').findIndex((l) => l.includes('-->'));
    if (arrowAt === -1) continue;
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const [left, right] = lines[arrowAt].split('-->');
    const toSec = (v: string) => {
      const parts = String(v).trim().replace(',', '.').split(':');
      if (parts.length === 3) return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
      if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
      return Number(parts[0]);
    };
    const from = toSec(left);
    const to = toSec(String(right).trim().split(/\s+/)[0]);
    const body = lines.slice(arrowAt + 1).join(' ').replace(/<[^>]{1,80}>/g, '').trim();
    if (!body || !Number.isFinite(from) || !Number.isFinite(to)) continue;
    out.push({ from, to: Math.max(to, from), text: body });
  }
  return out;
}
