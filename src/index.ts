/**
 * index.ts — 包入口。默认导出 WorldDefinition。
 *
 * `describe.tools` 是给**市场和人**看的自描述（describe.json 由它导出）；
 * 实例的 `tools()` 才是真正发给模型的那份。两边必须指同一批工具名，
 * 否则桌宠会在扩展页把"声明了但没实现"标出来。
 */

import { describeTools, type WorldDefinition } from 'cortico/world.ts';

import { VIDEO_READER_DEFAULTS, VIDEO_READER_ID, type VideoReaderConfigSection } from './config.ts';
import { TOOL_SUMMARY, VIDEO_READER_TOOL_DECLS } from './tools.ts';
import { VideoReaderWorld } from './world.ts';

export const VIDEO_READER: WorldDefinition<VideoReaderConfigSection> = {
  id: VIDEO_READER_ID,
  label: '视频读懂',
  defaults: () => structuredClone(VIDEO_READER_DEFAULTS),
  /**
   * 激活前的检查。**故意什么都不拦**：没装 ffmpeg、没登录都只是"降级"，
   * 不是"不能用" —— video_probe 在两种情况下都能给出有用的话。
   * 真拦下来，主人就看不到"为什么看不到视频"的那句解释了。
   */
  create: (ctx) => new VideoReaderWorld(ctx),
  describe: {
    tools: describeTools(VIDEO_READER_TOOL_DECLS, TOOL_SUMMARY),
    // 只读 World：不推任何事件。
    events: [],
  },
};

export default VIDEO_READER;
export { VIDEO_READER_CONFIG_GROUP, VIDEO_READER_DEFAULTS, VIDEO_READER_ID } from './config.ts';
export { VIDEO_READER_TOOL_DECLS } from './tools.ts';
export { VideoReaderWorld } from './world.ts';
