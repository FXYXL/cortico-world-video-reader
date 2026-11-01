/**
 * scripts/export-describe.mjs — 生成 describe.json。
 *
 * ## 为什么不是手写的
 *
 * 桌宠的市场**只读 describe.json，不执行扩展代码**；而 `check:extension` 会把它
 * 和"代码里导出的那份"逐字段比对，不一致就报错。手写两份必然漂移，
 * 所以直接从 `src/tools.ts` 与 `src/ENV_PROMPT.md` 生成。
 *
 * 用法（在包目录下）：
 *   node "<Coopanion>/resources/app/node_modules/tsx/dist/cli.mjs" scripts/export-describe.mjs
 *
 * 生成的字段顺序与桌宠 `describe-export.ts` 一致：tools → events → prompts。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { TOOL_SUMMARY, VIDEO_READER_TOOL_DECLS } from '../src/tools.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

// 与 cortico/world.ts 的 describeTools() 等价：只取给模型看的四个字段 + 给人看的一句 summary。
const tools = VIDEO_READER_TOOL_DECLS.map(({ name, description, parameters, tags }) => ({
  name,
  description,
  parameters,
  tags,
  summary: TOOL_SUMMARY[name],
}));

// 与 src/world.ts 的 webUi().promptDocs[0] 保持一致。
// **只写 PromptDescribe 里的四个字段** —— 桌宠的 check:extension 是逐字段深比较，
// 多一个 description 就算不一致（它能显示给人看，但不进 describe.json）。
const prompt = {
  key: 'worlds.video-reader.envPrompt',
  title: '视频读懂 · 环境说明',
  role: 'envPrompt',
  content: readFileSync(root + 'src/ENV_PROMPT.md', 'utf8'),
};

const file = { tools, events: [], prompts: [prompt] };

writeFileSync(root + 'describe.json', `${JSON.stringify(file, null, 2)}\n`, 'utf8');

const names = tools.map((t) => t.name).join(', ');
console.log(`describe.json 已生成：${tools.length} 个工具（${names}），1 段环境提示词。`);
