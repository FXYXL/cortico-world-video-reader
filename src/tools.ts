/**
 * tools.ts — 三个工具的契约（**不含 handler**）。
 *
 * 单独抽出来是为了让 describe.json 能对着它核对：市场只读 describe.json，
 * 不执行代码，所以这份声明必须和模型真正看到的完全一致。
 *
 * 命名沿用上游（`video_probe` / `video_storyboard` / `video_zoom`）：
 * 引擎生成的清单文本里硬编码了 `video_zoom({ cellId: 7 })` 这样的句子，
 * 改名会让结果里的提示指向一个不存在的工具。
 */

import type { ToolDef } from 'cortico/core/types.ts';

const video = {
  type: 'string',
  description:
    'Bilibili BV/av id or full video URL (share links like b23.tv must be expanded first), ' +
    'or an absolute local path to a video file.',
} as const;

const shared = {
  video,
  part: {
    type: 'integer',
    minimum: 1,
    description: 'Bilibili part (分P) number. Default 1. Ignored for local files.',
  },
  detail: {
    type: 'string',
    enum: ['low', 'med', 'high'],
    description:
      'Characters of subtitle per cell: low=60, med=120 (default), high=400 (quote level). ' +
      'Truncation lands on a sentence boundary.',
  },
  maxFrames: {
    type: 'integer',
    minimum: 0,
    description:
      'Cap on how many moments you see, 0-10000. Omit or 0 = no cap: every cut becomes a frame. ' +
      'Set a number only to bound cost - above it the shortest segments get merged (long takes are kept).',
  },
  maxSheets: {
    type: 'integer',
    minimum: 0,
    maximum: 64,
    description:
      'Cap on how many images this call may return. Omit to use the configured default. ' +
      'It is a budget cap, not a layout request: when the packer would exceed it, the shortest ' +
      'segments get merged and the layout is re-solved, so time coverage stays complete.',
  },
  strategy: {
    type: 'string',
    enum: ['full', 'standard', 'compact', 'skim', 'brief'],
    description:
      'Size policy, applied on top of the tier every frame got from cut density. Each step down costs ' +
      'about one tier of cell size (fewer images, blurrier cells): full = biggest cells, standard (default), ' +
      'compact, skim, brief = cheapest (you recognise shots, not content).',
  },
  budget: {
    type: 'integer',
    minimum: 64000,
    maximum: 640000,
    description:
      'Pixels per image. 640000 = 800x800 is the ceiling - the vision API caps a picture there, so a ' +
      'larger number is silently downscaled and the cell sizes in the manifest stop being true.',
  },
  textOnly: {
    type: 'boolean',
    description:
      'Return only the text index (no image, no frame decode). Use it to page through a long video ' +
      'after the first visual pass, or when the image budget for today is spent.',
  },
  cellRange: {
    type: 'array',
    items: { type: 'integer' },
    description:
      'Only render cells [first, last] (1-based, inclusive) in the text index. For a 2-hour video the ' +
      'full index can exceed one tool result; the index says where it stopped and which cellRange to ask for next.',
  },
  transcriptFile: {
    type: 'string',
    description:
      'Absolute path to an existing transcript (SRT, or JSON: [{start,end,text}] / Bilibili {body:[{from,to,content}]}). ' +
      'When given, the Bilibili subtitle track is skipped.',
  },
} as const;

export const VIDEO_READER_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'video_probe',
    tags: ['read'],
    description: [
      'Read what a video IS without downloading it: duration, parts, the resolutions this account can',
      'actually get, and whether subtitles exist. Costs one API call and no image tokens.',
      '',
      'Call it FIRST on a video you have not read yet, then read it:',
      '- A story (film / episode / documentary): SEQUENCE, never one overview -',
      '  video_storyboard({ video, from: 0, segment: 300 }) and follow the "next: from=..." it prints.',
      '- Just "what is this": video_storyboard({ video, maxFrames: 96 }). It spoils the ending.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { video, part: shared.part },
      required: ['video'],
    },
  },
  {
    name: 'video_storyboard',
    tags: ['read'],
    description: [
      'Turn a video into storyboard images you can cite, instead of guessing what is in it.',
      '',
      'Every frame is ONE SHOT: cuts are detected first, a cell is sized by how fast that stretch cuts',
      '(a 20-second take gets a full-width cell, a machine-gun montage gets 1/8-side cells), then a',
      'row-packing solver fills each image and opens the next when it is full. Cells are numbered and',
      'the numbering continues across images.',
      '',
      'The text index lists "cell 7 (image 1) = 00:12.76-00:31.40" with the subtitle spoken in that',
      'range, so you can quote a moment or ask for a close-up with video_zoom({ video, cellId: 7 }).',
      '',
      'KNOBS THAT MATTER (three): maxFrames (how many moments), strategy (how big each cell is),',
      'budget (pixels per image). Everything else is for narrow cases and documented inline.',
      '',
      'Long videos are read window by window with from + segment; a single overview of a whole film is',
      'only for identifying it (it spoils the ending and makes every cell smaller).',
      '',
      'The result is direct observation of pixels and subtitles only. It never claims to have watched',
      'the whole video or listened to the audio track.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...shared,
        from: { type: 'number', description: 'Window start in seconds (default 0). Only this window is scanned.' },
        to: {
          type: 'number',
          description:
            'Window end in seconds. Omit it to let `segment` size the window: 300 s when from > 0, ' +
            'or the whole file when from = 0.',
        },
        segment: {
          type: 'integer',
          minimum: 30,
          maximum: 3600,
          description:
            'Window length in seconds when you pass `from` without `to`. This is the SEQUENCE reader: ' +
            'call once with from:0, segment:300, then pass back the "next: from=..." printed at the end ' +
            'of every result. Use 300 for films and 120-180 for dense action.',
        },
        scanGap: {
          type: 'number',
          description:
            'Minimum seconds between two detected cuts, 0-30. Default 0 = merge nothing. Raise it to ' +
            'collapse machine-gun edits into one boundary.',
        },
      },
      required: ['video'],
    },
  },
  {
    name: 'video_zoom',
    tags: ['read'],
    description: [
      'Re-read a short window of a video at higher per-cell resolution - faces, subtitles and on-screen',
      'text become legible where a 16-cell overview cannot show them.',
      '',
      'Use it after video_storyboard when one cell needs a closer look. Pass cellId (the number printed',
      'on the cell) or from/to in seconds. Keep the window short: a few seconds to a minute. Costs one',
      'image, like any other result with one image. For another wide pass use video_storyboard instead.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        video,
        part: shared.part,
        from: { type: 'number', description: 'Window start in seconds. Required unless cellId is given.' },
        to: { type: 'number', description: 'Window end in seconds. Required unless cellId is given.' },
        cellId: {
          type: 'integer',
          minimum: 1,
          description:
            'Zoom by cell number from the last video_storyboard of this same video (e.g. 7 = the cell ' +
            'labelled 7). Resolves to that cell\'s absolute time range, so timestamps never get copied by hand.',
        },
        maxFrames: {
          type: 'integer',
          minimum: 0,
          maximum: 48,
          description:
            'How many frames for this window, default 9. Frames get a uniform tier so n cells tile a ' +
            'sqrt(n) x sqrt(n) grid in ONE image.',
        },
        strategy: {
          type: 'string',
          enum: ['full', 'standard', 'compact', 'skim', 'brief'],
          description: 'Size policy; defaults to the biggest cells. Lower it only for a very busy window.',
        },
        detail: shared.detail,
        transcriptFile: shared.transcriptFile,
      },
      required: ['video'],
    },
  },
];

/** 给人看的一句话（describe.json 里的 summary 字段用它）。 */
export const TOOL_SUMMARY: Record<string, { zh: string; en: string }> = {
  video_probe: {
    zh: '只读视频的时长、分P、可用清晰度与字幕有无，不下载、不出图。',
    en: 'Reads duration, parts, available resolutions and subtitle availability without downloading.',
  },
  video_storyboard: {
    zh: '把一段视频压成带时间戳的分镜图：每格一个镜头，附逐格字幕与底部音频波形。',
    en: 'Compresses a video into a timestamped storyboard: one frame per shot, per-cell subtitles and an audio strip.',
  },
  video_zoom: {
    zh: '对某一格或某一小段时间近距离重看，格子更大、字幕更清楚。',
    en: 'Re-reads one cell or a short window at higher per-cell resolution.',
  },
};
