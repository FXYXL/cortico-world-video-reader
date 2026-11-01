/**
 * test/check-real-framework.mjs — 可选：用**桌宠自己的框架模块**核对一遍。
 *
 * `check-describe.mjs` 用的是本地桩（复刻 `describeTools` 的五行）。这个脚本更进一步：
 * 注册桌宠运行时的同一个解析钩子（`cortico/*` → `<app>/build/cortico/src/*`），
 * 于是 `import 'cortico/world.ts'` 拿到的是**真货**。
 *
 * 找不到桌宠时直接跳过（CI / 别人的机器上不会失败）。
 *
 *   node "<Coopanion>/resources/app/node_modules/tsx/dist/cli.mjs" test/check-real-framework.mjs
 *   COOPANION_APP=/path/to/resources/app node ...
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const app = process.env.COOPANION_APP || 'D:/Coopanion/resources/app';
const runtime = join(app, 'build', 'cortico', 'src', 'extensions', 'runtime.ts');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log('视频读懂 · 真框架核对\n');

if (!existsSync(runtime)) {
  console.log(`跳过：没找到桌宠运行时（${runtime}）。设 COOPANION_APP 指向 resources/app 再试。`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'video-reader-real-'));
try {
  // 导入即注册钩子（runtime.ts 的模块副作用）
  await import(pathToFileURL(runtime).href);
  check('已注册桌宠的 cortico/* 解析钩子', true);

  const framework = await import('cortico/world.ts');
  check('拿到真的 describeTools', typeof framework.describeTools === 'function');

  const mod = await import(new URL('../src/index.ts', import.meta.url).href);
  const def = mod.default;
  check('本包默认导出能被真框架的 describeTools 处理', Array.isArray(def.describe.tools) && def.describe.tools.length === 3,
    def.describe.tools.map((t) => t.name).join(', '));

  const ctx = {
    id: def.id,
    cfg: def.defaults(),
    timezone: 'Asia/Shanghai',
    botName: 'test',
    botDir: dir,
    packageDir: new URL('..', import.meta.url).pathname,
    dataDir: join(dir, 'data'),
    repoRoot: dir,
    secret: () => '',
    storeSecret: () => {},
    persist: () => {},
    restart: async () => {},
  };
  const world = def.create(ctx);
  check('构造 World 不抛错', Boolean(world?.id));
  check('tools() 返回三个工具', world.tools().length === 3);
  check('webUi() 能渲染', Boolean(world.webUi('zh')?.config?.length));
  check('envPromptVars() 三个变量', Object.keys(world.envPromptVars() ?? {}).length === 3);

  console.log(`\n${failures === 0 ? '全部通过。' : `有 ${failures} 项没过。`}`);
} catch (error) {
  console.error(`\n失败：${error?.stack ?? error}`);
  failures += 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
