/**
 * test/stub-cortico-world.mjs — Coopanion 框架模块的本地桩。
 *
 * 只在 `test/check-describe.mjs` 里用，**不进发布包**（package.json 的 files 不含 test）。
 * 复刻的是 `cortico/world.ts` 里 `describeTools()` 的行为：给模型看的四个字段 + 一句 summary。
 * 类型导入（`cortico/core/types.ts`）在运行时会被 tsx 擦掉，指到这里只是为了让解析不报错。
 */

export function describeTools(decls, summaries) {
  return decls.map(({ name, description, parameters, tags }) => ({
    name,
    description,
    parameters,
    tags,
    summary: summaries[name],
  }));
}
