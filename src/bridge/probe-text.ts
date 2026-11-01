/**
 * bridge/probe-text.ts — `video_probe` 的正文。
 *
 * 目标只有一个：**让模型在花掉第一张图之前就知道该怎么读这条视频**。
 * 所以这里不报"文件大小/码率"这类给人看的数字，只报三件能改变决策的事：
 *   1. 多长（决定要不要分段）、几个分P（决定读哪一集）；
 *   2. 实际能拿到多少清晰度（决定"能不能看清字幕"）；
 *   3. 有没有字幕（决定"读不读得到台词"）。
 */

import type { BiliMeta, PlayInfo, SubtitleInfo } from './bilibili.js';

export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(ss).padStart(2, '0')}`;
}

/** 480P 大约 0.5 Mbps，用来给"要不要现在下"一个数量感。**只是估算**，结果里会写明。 */
function estimateDownloadMB(durationSec: number, height: number): number {
  const mbps = height >= 1080 ? 2.4 : height >= 720 ? 1.4 : 0.55;
  return Math.round(((durationSec * mbps) / 8) * 1.0);
}

export interface ProbeFacts {
  meta: BiliMeta;
  play: PlayInfo;
  subtitle: SubtitleInfo;
  loggedIn: boolean;
  scanHeight: number;
  withCookie: boolean;
}

export function formatBiliProbe(f: ProbeFacts): string {
  const { meta, play, subtitle } = f;
  const lines: string[] = [];

  lines.push(
    `<video source="bilibili" id="${meta.bvid}" part="${meta.part}/${Math.max(1, meta.parts.length)}" ` +
      `duration="${meta.partDuration.toFixed(2)}s" full="${meta.duration.toFixed(2)}s" />`,
  );
  lines.push(`title: ${meta.title}`);
  if (meta.author) lines.push(`author: ${meta.author}`);
  lines.push(`time: ${clock(meta.partDuration)}`);
  lines.push(`url: ${meta.url}`);
  if (meta.parts.length > 1) {
    const shot = meta.parts
      .slice(0, 12)
      .map((p) => `  p${p.page} ${clock(p.duration)} ${p.title || '(无标题)'}`)
      .join('\n');
    lines.push(`parts (${meta.parts.length})${meta.parts.length > 12 ? ' — 前 12 集' : ''}:\n${shot}`);
  }

  // 清晰度：报"这次真能拿到什么"，不是"B站有 4K"。
  const avail = play.qualityLabels.filter(Boolean);
  lines.push(
    `resolution: request ${play.requestedHeight}p → got ${play.height ?? '?'}p` +
      (avail.length ? `; account can reach: ${avail.slice(-5).join('/')}` : ''),
  );
  lines.push(`login: ${f.loggedIn ? 'signed in (shared with the social plugin)' : 'anonymous (low resolution only)'}`);
  for (const d of play.degraded) lines.push(`!! degraded: ${d}`);

  lines.push(
    subtitle.available
      ? `subtitles: YES${subtitle.langDoc ? ` (${subtitle.langDoc})` : ''} — ${subtitle.segments.length} lines; the storyboard will quote them per cell, no ASR needed.`
      : `subtitles: NO — ${subtitle.reason ?? 'not provided'}; the storyboard will be visual only.`,
  );

  // 读法建议
  const mins = meta.partDuration / 60;
  lines.push('');
  if (mins > 8) {
    const seg = 300;
    const total = Math.max(1, Math.ceil(meta.partDuration / seg));
    const estMB = estimateDownloadMB(meta.partDuration, f.scanHeight);
    lines.push(`This one is ${mins.toFixed(0)} min — read it window by window, not in one pass.`);
    lines.push(`  SEQUENCE (no spoilers, default for anything with a plot):`);
    lines.push(`    video_storyboard({ video: "${meta.bvid}", from: 0, segment: ${seg} })`);
    lines.push(
      `  ${total} windows of ${seg}s. Every result ends with "segment k/${total} · x% watched · y min left · next: from=..." — ` +
        'pass that from back to continue. One image per window; the subtitle track is read once and cached after that.',
    );
    lines.push(`  STRUCTURE (spoilers, only to identify it):`);
    lines.push(`    video_storyboard({ video: "${meta.bvid}", maxFrames: 96 })`);
    lines.push('');
    lines.push(
      `cost: the first call downloads a ${f.scanHeight}p copy once (roughly ${estMB} MB, estimated) and caches it; ` +
        'later calls on the same part reuse it. video_zoom never downloads - it reads frames from the original stream.',
    );
  } else if (mins < 1) {
    lines.push(`Under a minute (${meta.partDuration.toFixed(0)}s): one call is enough — video_storyboard({ video: "${meta.bvid}" }).`);
  } else {
    lines.push(`Short (${mins.toFixed(0)} min): one call is enough — video_storyboard({ video: "${meta.bvid}" }).`);
    lines.push('If it has a plot and you would rather not see later scenes early, use from + segment (e.g. segment: 120).');
  }

  if (!subtitle.available && f.withCookie) {
    lines.push('');
    lines.push(
      'note: no subtitle track found. Reading the audio is not implemented in this version, so speech is not available — ' +
        'only what is visible on screen (including burned-in subtitles, which appear inside the cells).',
    );
  }
  return lines.join('\n');
}

/** 本地文件的 probe：交给引擎的 ffprobe，正文只补一句读法。 */
export function formatLocalProbe(info: any, path: string): string {
  const lines = [
    `<video source="local" path="${path}" duration="${Number(info.duration).toFixed(2)}s" ` +
      `size="${info.width}x${info.height}" fps="${Number(info.fps).toFixed(2)}" ` +
      `audio="${info.hasAudio ? 'yes' : 'no'}" subtitles="${info.hasSubtitle ? 'yes' : 'no'}" />`,
    `time: ${clock(Number(info.duration))}`,
  ];
  const mins = Number(info.duration) / 60;
  lines.push('');
  if (mins > 8) {
    const seg = 300;
    lines.push(`This one is ${mins.toFixed(0)} min — read it window by window:`);
    lines.push(`  video_storyboard({ video: "${path.replace(/\\/g, '\\\\')}", from: 0, segment: ${seg} })`);
  } else {
    lines.push(`one call is enough — video_storyboard({ video: "${path.replace(/\\/g, '\\\\')}" }).`);
  }
  if (!info.hasAudio) lines.push('no audio track; the grid is visual only.');
  lines.push('local files are read at their own resolution; nothing is downloaded.');
  return lines.join('\n');
}
