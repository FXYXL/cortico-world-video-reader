/**
 * engine/load.js — 唯一一处把 Coopanion 配置接到 DSH 引擎的地方。
 *
 * **纯 JavaScript**：这个文件要能在没有 Coopanion 运行时的环境里跑
 * （`node test/smoke.test.mjs` 就是靠它把"引擎在这台机器上能不能跑"
 * 与"B站的登录/风控"分开的）。类型用 JSDoc 写。
 *
 * ## 为什么必须用**动态** import
 *
 * 引擎的 `binaries.js` 在**模块加载那一刻**就把 ffmpeg 路径定死了：
 *
 *     export const DEFAULT_FFMPEG = resolveMediaBinary('ffmpeg') || 'ffmpeg';
 *
 * `scan.js` / `audio.js` / `sheet.js` 里还有几处默认参数用的是这个快照。
 * 静态 import 会被提升到文件顶部执行，那时环境变量还没设，配置里填的绝对路径就是白填。
 * 所以：**先设环境变量，再 import** —— 顺序由这个文件保证。
 *
 * ## 为什么整个引擎按需加载，而不是在 World 构造时加载
 *
 * 桌宠启动时会等所有挂载 World 的 `start()`。引擎有 40 多个模块、还链到 Python 探测那一串，
 * 一旦哪台机器上某个 import 卡住（路径解析、缺文件），表现就是"装了这个扩展，桌宠起不来"，
 * 而且日志里什么都没有。按需加载把最坏情况从"应用起不来"降级成"第一次调用工具时报错"。
 *
 * ## 暴露什么
 *
 * 只暴露 `src/world.ts` 真正用到的那些。引擎内部还有几十个导出（格式渲染、字幕长图、
 * OCR……），需要时再往这里加一行 —— 加之前先问"是不是 world.ts 已经在用了"。
 */

import { join } from 'node:path';

/**
 * 把配置写进 process.env。
 * 幂等、便宜，所以**每次调用工具前都可以再跑一遍** —— 配置热更新后新值立刻生效。
 *
 * @param {{ dataDir: string, ffmpegFile?: string, ffprobeFile?: string, mediaMaxMB?: number }} env
 */
export function applyEngineEnv(env) {
  process.env.DSH_VIDEO_CACHE_DIR = join(env.dataDir, 'cache');
  process.env.DSH_VIDEO_MEDIA_DIR = join(env.dataDir, 'media');
  if (Number.isFinite(env.mediaMaxMB) && env.mediaMaxMB > 0) {
    process.env.DSH_VIDEO_MEDIA_MAX_MB = String(Math.round(env.mediaMaxMB));
  }
  // **只在配置非空时覆盖**：留空是"用 PATH 上的 ffmpeg"，
  // 不能被写成空串把用户自己设过的环境变量抹掉。
  if (typeof env.ffmpegFile === 'string' && env.ffmpegFile.trim()) {
    process.env.DSH_FFMPEG_PATH = env.ffmpegFile.trim();
  }
  if (typeof env.ffprobeFile === 'string' && env.ffprobeFile.trim()) {
    process.env.DSH_FFPROBE_PATH = env.ffprobeFile.trim();
  }
}

/** 已加载的引擎实例（见文件头的"按需加载"）。 */
let cached = null;
let pending = null;

/**
 * 加载引擎。**必须在 applyEngineEnv() 之后调用**；重复调用返回同一个实例。
 *
 * @param {{ dataDir: string, ffmpegFile?: string, ffprobeFile?: string, mediaMaxMB?: number }} env
 */
export async function loadEngine(env) {
  applyEngineEnv(env);
  if (cached) return cached;
  if (pending) return pending;

  pending = (async () => {
    const [pipeline, board, format, spec, cells, probe, mediaStore, locate, subtitleStrip, bins] = await Promise.all([
      import('./storyboard/pipeline.js'),
      import('./storyboard/board.js'),
      import('./storyboard/format.js'),
      import('./storyboard/tool-spec.js'),
      import('./storyboard/cells.js'),
      import('./storyboard/probe.js'),
      import('./storyboard/media-store.js'),
      import('./storyboard/locate.js'),
      import('./storyboard/subtitle-strip.js'),
      import('./storyboard/binaries.js'),
    ]);

    cached = {
      runStoryboard: pipeline.runStoryboard,
      boardOptions: board.boardOptions,
      formatForDetail: format.formatForDetail,
      validateToolArgs: spec.validateToolArgs,
      validateZoomArgs: spec.validateZoomArgs,
      lookupCell: (path, cellId) => cells.lookupCell(path, cellId),
      probeVideo: probe.probeVideo,
      mediaDir: () => mediaStore.mediaDir(),
      mediaKey: (normalized, height) => mediaStore.mediaKey(normalized, height),
      mediaMaxBytes: () => mediaStore.mediaMaxBytes(),
      pruneMedia: (o) => mediaStore.pruneMedia(o),
      matchSegments: locate.matchSegments,
      formatMatches: locate.formatMatches,
      buildSubtitleStrip: subtitleStrip.buildSubtitleStrip,
      defaultBand: subtitleStrip.DEFAULT_BAND,
      resolveMediaBinary: bins.resolveMediaBinary,
    };
    return cached;
  })();

  try {
    return await pending;
  } catch (error) {
    // 失败不缓存：下一次调用可以重试（例如用户刚把 ffmpeg 装好、或修好了路径）。
    pending = null;
    cached = null;
    throw error;
  }
}

/** 测试或热重载用：丢掉已加载的引擎实例。 */
export function resetEngine() {
  cached = null;
  pending = null;
}
