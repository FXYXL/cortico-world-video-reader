/**
 * bridge/usage.ts — 本 World 自己的预算账本。
 *
 * ## 为什么不能省
 *
 * 社交视窗那套 `maxDailyVisualCalls` 只统计它自己的工具。本 World 的工具
 * **不计入它的任何额度** —— 也就是说，如果不自带账本，自主闲逛时"今日 20 轮"看着很正常，
 * 实际却在无上限地花图片 token。所以两边各自记账，互不代管。
 *
 * 账本只有两个数：今天出图几次、累计交付了多少字节图片。
 * 掉了就重来（宁可多给一次，也不要因为账本坏了读不了视频）。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

interface Ledger {
  kind: 'video-reader-usage-v1';
  /** 部署时区的 YYYY-MM-DD。 */
  day: string;
  calls: number;
  deliveredBytes: number;
}

export class UsageLedger {
  private readonly file: string;
  private state: Ledger;
  /** 格式化器建一次就够 —— envPromptVars / WebUI 会频繁问"今天几次"。 */
  private readonly dayOf: Intl.DateTimeFormat | null;

  constructor(private readonly dir: string, timezone: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'usage.json');
    try {
      this.dayOf = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      // 时区名坏了不该让读视频失败
      this.dayOf = null;
    }
    this.state = this.read();
  }

  private today(): string {
    if (!this.dayOf) return new Date().toISOString().slice(0, 10);
    try {
      return this.dayOf.format(new Date());
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }

  private read(): Ledger {
    const fresh: Ledger = { kind: 'video-reader-usage-v1', day: this.today(), calls: 0, deliveredBytes: 0 };
    try {
      if (!existsSync(this.file)) return fresh;
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (raw?.kind !== 'video-reader-usage-v1') return fresh;
      return {
        kind: 'video-reader-usage-v1',
        day: typeof raw.day === 'string' ? raw.day : fresh.day,
        calls: Number.isSafeInteger(raw.calls) && raw.calls >= 0 ? raw.calls : 0,
        deliveredBytes: Number.isFinite(raw.deliveredBytes) && raw.deliveredBytes >= 0 ? raw.deliveredBytes : 0,
      };
    } catch {
      return fresh;
    }
  }

  private roll(): void {
    const day = this.today();
    if (this.state.day !== day) {
      this.state.day = day;
      this.state.calls = 0;
      this.save();
    }
  }

  private save(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // 写不进去就只影响"重启后计数"这件事，不该让工具失败
    } finally {
      try {
        rmSync(`${this.file}.${process.pid}.tmp`, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }

  get calls(): number {
    this.roll();
    return this.state.calls;
  }

  get deliveredMB(): number {
    return this.state.deliveredBytes / 1048576;
  }

  /** 出图前检查。抛错 = 这次不跑，调用方据此返回"改用文本"。 */
  assertAllowed(maxDailyCalls: number, maxDeliveredMB: number): void {
    this.roll();
    if (this.state.calls >= maxDailyCalls) {
      throw new Error(
        `今日出图次数已用完（${this.state.calls}/${maxDailyCalls}）。` +
          '可以继续用 textOnly 读文本索引，或让主人在配置页提高上限。',
      );
    }
    if (this.state.deliveredBytes >= maxDeliveredMB * 1048576) {
      throw new Error(
        `累计图片交付预算已用完（${this.deliveredMB.toFixed(0)}MB/${maxDeliveredMB}MB）。` +
          '仍然可以读文本索引（textOnly），或让主人在配置页提高预算。',
      );
    }
  }

  /** 记一次出图。**失败也记**：不然模型重试会把额度刷穿。 */
  countCall(): void {
    this.roll();
    this.state.calls += 1;
    this.save();
  }

  countDelivered(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.state.deliveredBytes += bytes;
    this.save();
  }

  /**
   * 给面板看的一行摘要。
   * 注意**没有"清零"接口**：用量是护栏，不该被随手抹掉。
   * 真要从头开始，改配置页的上限，或者删掉 `<dataDir>/state/usage.json`。
   */
  describe(): string {
    this.roll();
    return `今日 ${this.state.calls} 次出图；累计交付 ${this.deliveredMB.toFixed(1)} MB`;
  }
}
