/**
 * test/check-describe.mjs — 核对 describe.json 与代码里那份自描述是否一致。
 *
 * 桌宠的市场**只读 describe.json，不执行扩展代码**；而 `pnpm check:extension`
 * 会把这份文件和"代码里导出的那份"逐字段深比较。所以作者改完工具就必须重新导出，
 * 否则市场页显示的工具说明会和模型实际看到的不一样 —— 这种漂移最难发现。
 *
 * 这里在 Coopanion **之外**复刻同一条检查：把 `cortico/world.ts` 解析到一个本地桩，
 * 真跑一遍 `defaults() → create(ctx) → tools() → webUi('zh')`，再和 describe.json 比。
 *
 *   node "<Coopanion>/resources/app/node_modules/tsx/dist/cli.mjs" test/check-describe.mjs
 */

import { isDeepStrictEqual } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 1) 把框架的运行时 import 指到本地桩（类型导入会被 tsx 擦掉，只有 describeTools 是真的要执行）
const stubUrl = new URL('./stub-cortico-world.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cortico/world.ts') return { url: stubUrl, shortCircuit: true };
    if (specifier === 'cortico/core/types.ts') return { url: stubUrl, shortCircuit: true };
    return next(specifier, context);
  },
});

const root = new URL('../', import.meta.url);
const dataDir = mkdtempSync(join(tmpdir(), 'video-reader-check-'));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

try {
  console.log('视频读懂 · 自描述核对\n');

  const mod = await import(new URL('src/index.ts', root).href);
  const def = mod.default;

  check('默认导出是 WorldDefinition', Boolean(def?.id && def?.create && def?.describe), def?.id);

  // 2) 生成"代码里那份"（和桌宠 exportDescribe 的路径一致：JSON 往返后再比）
  const generated = JSON.parse(
    JSON.stringify({
      tools: [...def.describe.tools],
      events: [...def.describe.events],
    }),
  );

  // 3) 真的构造一个实例，读它的 tools() 与 promptDocs
  const ctx = {
    id: def.id,
    cfg: def.defaults(),
    timezone: 'Asia/Shanghai',
    botName: 'check',
    botDir: dataDir,
    packageDir: new URL('.', root).pathname,
    dataDir,
    repoRoot: dataDir,
    secret: () => '',
    storeSecret: () => {},
    persist: () => {},
    restart: async () => {},
  };
  const world = def.create(ctx);
  const live = world.tools().map(({ name, description, parameters }) => ({ name, description, parameters }));
  const declared = new Set(generated.tools.map((t) => t.name));

  check('实例工具非空', live.length > 0, live.map((t) => t.name).join(', '));
  for (const t of live) check(`tools() 里的 ${t.name} 已在声明中`, declared.has(t.name));

  // 声明了但实例不提供：桌宠会在扩展页标出来，属于作者疏漏
  for (const name of declared) {
    check(`声明的 ${name} 确实由实例提供`, live.some((t) => t.name === name));
  }

  // 4) promptDocs → prompts 段（只有 role=envPrompt 且文件存在的才进 describe.json）
  const docs = (world.webUi?.('zh')?.promptDocs ?? []).filter((d) => d.role === 'envPrompt');
  const prompts = docs
    .filter((d) => {
      try {
        readFileSync(d.path);
        return true;
      } catch {
        return false;
      }
    })
    .map((d) => ({
      key: d.key,
      title: d.title,
      ...(d.role ? { role: d.role } : {}),
      content: readFileSync(d.path, 'utf8'),
    }));
  const withPrompts = prompts.length ? { ...generated, prompts } : generated;

  // 5) 与磁盘上那份比
  const written = JSON.parse(readFileSync(new URL('describe.json', root), 'utf8'));
  check(
    'describe.json 与代码一致',
    isDeepStrictEqual(written, JSON.parse(JSON.stringify(withPrompts))),
    isDeepStrictEqual(written, JSON.parse(JSON.stringify(withPrompts)))
      ? ''
      : '不一致 —— 重新跑 scripts/export-describe.mjs',
  );
  if (!isDeepStrictEqual(written, JSON.parse(JSON.stringify(withPrompts)))) {
    console.log('\n--- 磁盘上的 ---');
    console.log(JSON.stringify(written, null, 2).slice(0, 1200));
    console.log('\n--- 代码里的 ---');
    console.log(JSON.stringify(withPrompts, null, 2).slice(0, 1200));
  }

  // 6) package.json 的声明与 CHANGELOG
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  check('package.json 是 type=module', pkg.type === 'module');
  check('cortico.kind = world', pkg.cortico?.kind === 'world', String(pkg.cortico?.kind));
  check('cortico.api = 6', pkg.cortico?.api === 6, String(pkg.cortico?.api));
  check('cortico.describe 指向存在的文件', pkg.cortico?.describe === 'describe.json');
  check('main 指向存在的入口', Boolean(pkg.main) && /\.ts$/.test(pkg.main), String(pkg.main));
  check('keywords 含 cortico-world', (pkg.keywords ?? []).includes('cortico-world'));

  const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8');
  const hasVersion = changelog
    .replace(/\r\n/g, '\n')
    .split('\n')
    .some((line) => {
      const head = /^##\s+(.*)$/.exec(line);
      return Boolean(head) && /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(head[1])?.[0] === pkg.version;
    });
  check(`CHANGELOG.md 有 "## ${pkg.version}" 一段（市场靠它显示更新说明）`, hasVersion);

  console.log(`\n${failures === 0 ? '全部通过。' : `有 ${failures} 项没过。`}`);
} catch (error) {
  console.error(`\n未预期的失败：${error?.stack ?? error}`);
  failures += 1;
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
