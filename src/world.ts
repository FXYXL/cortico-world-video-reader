/**
 * world.ts — 「视频读懂」这个 World 的全部行为。
 *
 * ## 它和社交视窗的关系
 *
 * **只读、不耦合**。三样东西对接，一件代码都不互相 import：
 *
 *   1. **登录**：读部署 .env 里社交视窗扫码存下的 `SOCIALMEDIA_BILIBILI_COOKIE`。只读，绝不写。
 *      （写它会换掉社交视窗的账号绑定，历史发言会突然"不属于当前账号"。）
 *   2. **视频编号**：统一用 BV + 分P。工具输出的 `video` 字段可以原样传给 `socialmedia_*`。
 *   3. **上下文**：分镜结果的台词与格号就是可引用的证据，模型拿它去 `socialmedia_prepare`。
 *
 * ## 三条自我约束（缺一条都会变成"看起来很能干"的插件）
 *
 * - **不假装看过**：结果只声明"这些格、这些台词"；从不说看过全片或听过音频。
 * - **自带预算**：社交视窗的额度只管它自己的工具，这里的调用不计入它 —— 所以自己记账。
 * - **降级要说出来**：1080P 拿不到、字幕没有、ffmpeg 不在，全部写进结果，不静默降级。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Language, ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { WorldContext } from 'cortico/world.ts';

import { VIDEO_READER_CONFIG_GROUP, VIDEO_READER_ID, type VideoReaderConfigSection } from './config.ts';
import { VIDEO_READER_TOOL_DECLS } from './tools.ts';
import { applyEngineEnv, loadEngine, type Engine } from './engine/load.js';
import { BiliError, BilibiliClient, type BiliMeta, type SubtitleInfo } from './bridge/bilibili.ts';
import { resolveSource, type PreparedSource } from './bridge/source.ts';
import { UsageLedger } from './bridge/usage.ts';
import { formatBiliProbe, formatLocalProbe, clock } from './bridge/probe-text.ts';
import { loadTranscript } from './bridge/transcript.ts';
import { audioHint } from './bridge/audio-hint.ts';
import { dirSize, ensureDirs, fileCount, migrateLegacy, type WorldDirs } from './bridge/paths.ts';
import { resolveAsrConfig } from './bridge/asr.ts';

const ENV_PROMPT_PATH = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

type Args = Record<string, unknown>;

const isHttp = (v: string) => /^https?:\/\//i.test(v);
const isBili = (v: string) => /bilibili\.com/i.test(v) || /^(BV[0-9A-Za-z]{10}|av\d{1,20})$/i.test(v.trim());

/** 体积显示：小数值保留一位，免得 0.2MB 显示成 "0MB"。 */
const mb = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));

/**
 * 长于这个秒数、又没给 from/to/segment 时，自动按窗口读第一段 —— 免得一上手就烧完整片。
 *
 * **必须和 probe 里给建议的阈值一致**（`probe-text.ts` 与引擎 `format.js` 都用 8 分钟）。
 * 不一致的代价很具体：一条 13 分钟的片子，probe 说"分 3 段读"，模型照做调了
 * `video_storyboard({ video })`（不给 from），护栏却因为没到 20 分钟而不触发，
 * 于是出了一张盖住全片的总览 —— 8 张图 3072 token，剧透，而且每格更小。
 * 实测踩过（BV1L7nz6oEAN，13 分钟，8 张图）。
 *
 * 经验阈值：4 张图 = 1536 token，已经比"分段第一张 384"贵 4 倍。8 分钟是分界。
 */
const LONG_VIDEO_SEC = 480;

export class VideoReaderWorld implements World {
  readonly id = VIDEO_READER_ID;
  private host: WorldHost | null = null;
  private readonly ledger: UsageLedger;
  /** 本 World 的私有目录（见 bridge/paths.ts 的说明：ctx.dataDir 是全部署共享的）。 */
  private readonly dirs: WorldDirs;
  private lastError: string | null = null;
  /** ffmpeg 自检结果缓存：WebUI 每次渲染都问，不能每次都起一个进程。 */
  private ffprobeCheck: { at: number; ok: boolean } = { at: 0, ok: false };
  /** 缓存目录体积缓存（同上）。 */
  private sizeCache: { at: number; media: number; cache: number } = { at: 0, media: 0, cache: 0 };

  constructor(private readonly ctx: WorldContext<VideoReaderConfigSection>) {
    const dirs = ensureDirs(ctx.dataDir);
    this.dirs = dirs;
    this.ledger = new UsageLedger(dirs.state, ctx.timezone);
  }

  /* ------------------------------------------------------------ 生命周期 */

  /**
   * **故意不 await 引擎加载**。
   *
   * 桌宠启动时会等所有挂载 World 的 `start()`。引擎有 40 多个模块，
   * 一旦某台机器上某个 import 卡住，"装了这个扩展，桌宠起不来"就会发生，而日志里什么都没有。
   * 所以这里只登记 host 并**在后台预热**：最坏情况是"第一次调用工具时报错"，不是"应用起不来"。
   */
  async start(host: WorldHost): Promise<void> {
    this.host = host;
    // 老版本把数据写在共享目录里（详见 bridge/paths.ts 的说明）。
    // 迁移放在这里、**同步做完再预热**：它只是几次 rename，几十毫秒，
    // 而"第一次调用工具时才发现媒体还在共享区"会带来更奇怪的现象。
    try {
      const r = migrateLegacy(this.ctx.dataDir);
      if (r.moved > 0) this.log(`迁移了 ${r.moved} 项到私有目录：${r.notes.join('; ').slice(0, 200)}`);
    } catch (error) {
      // 迁移失败不该让插件起不来 —— 只是老数据还在原地
      this.log(`迁移失败（老数据仍在共享目录）：${(error as Error).message.slice(0, 120)}`);
    }
    void this.warmup();
  }

  private async warmup(): Promise<void> {
    try {
      await this.engine();
      this.lastError = null;
      this.log('engine ready');
    } catch (error) {
      this.lastError = message(error);
      this.log(`engine load failed: ${this.lastError}`);
    }
  }

  async stop(): Promise<void> {
    this.host = null;
  }

  /** 只读 World：不推事件，也不往环境段里塞状态以外的任何东西。 */
  envPromptVars(): Record<string, string> {
    const cfg = this.cfg();
    return {
      'videoreader.login': this.cookie()
        ? '已共享社交视窗的 B站登录'
        : '未登录（只能拿到低清晰度，且多半没有字幕）',
      'videoreader.ffmpeg': this.ffmpegReady() ? '就绪' : `未找到（当前取 ${this.ffmpegPath()}）`,
      'videoreader.quota': `${this.ledger.calls}/${cfg.maxDailyCalls} 次出图，累计交付 ${mb(this.ledger.deliveredMB)}MB`,
    };
  }

  /* ------------------------------------------------------------ 配置与依赖 */

  private cfg(): VideoReaderConfigSection {
    return this.ctx.cfg;
  }

  /** 读别人的登录，**不写**。 */
  private cookie(): string {
    const name = String(this.cfg().cookieSecret ?? '').trim();
    if (!name) return '';
    try {
      return this.ctx.secret(name) || '';
    } catch {
      return '';
    }
  }

  private client(): BilibiliClient {
    return new BilibiliClient(() => this.cookie());
  }

  private ffmpegPath(): string {
    const v = String(this.cfg().ffmpegFile ?? '').trim();
    if (v) return v;
    return process.env.DSH_FFMPEG_PATH?.trim() || 'ffmpeg';
  }

  private ffprobePath(): string {
    const v = String(this.cfg().ffprobeFile ?? '').trim();
    if (v) return v;
    return process.env.DSH_FFPROBE_PATH?.trim() || 'ffprobe';
  }

  /**
   * 每次调用都重设一遍环境变量：配置是**活引用**，主人改了清晰度/缓存上限之后
   * 下一次工具调用就该用新值，不该等重启。
   */
  private async engine(): Promise<Engine> {
    const cfg = this.cfg();
    const env = {
      dataDir: this.dirs.root,
      ffmpegFile: String(cfg.ffmpegFile ?? ''),
      ffprobeFile: String(cfg.ffprobeFile ?? ''),
      mediaMaxMB: Number(cfg.mediaMaxMB) || 300,
    };
    applyEngineEnv(env);
    return loadEngine(env);
  }

  private ffmpegReady(): boolean {
    const now = Date.now();
    if (now - this.ffprobeCheck.at < 60_000) return this.ffprobeCheck.ok;
    let ok = false;
    try {
      const r = spawnSync(this.ffmpegPath(), ['-version'], { stdio: 'ignore', timeout: 20_000, windowsHide: true });
      ok = r.status === 0;
    } catch {
      ok = false;
    }
    this.ffprobeCheck = { at: now, ok };
    return ok;
  }

  private log(msg: string): void {
    try {
      (this.host as unknown as { log?: { info?: (s: string) => void } })?.log?.info?.(`[video-reader] ${msg}`);
    } catch {
      /* 连日志都写不了就算了 */
    }
  }

  /* ------------------------------------------------------------ 工具注册 */

  tools(): ToolDef[] {
    const handlers: Record<string, (a: Args, c?: { signal?: AbortSignal }) => Promise<ToolOutcome>> = {
      video_probe: (a, c) => this.probe(a, c),
      video_storyboard: (a, c) => this.storyboard(a, c),
      video_zoom: (a, c) => this.zoom(a, c),
      video_locate: (a, c) => this.locate(a, c),
      video_subtitles: (a, c) => this.subtitles(a, c),
    };
    return VIDEO_READER_TOOL_DECLS.map((decl) => ({
      name: decl.name,
      description: decl.description,
      parameters: decl.parameters,
      tags: [...decl.tags],
      // 一部两小时的片子首次要几分钟；被打断时应当尽快交回已完成的部分，而不是拖住整轮。
      interruptible: true,
      handler: async (args: Args, callCtx: { signal?: AbortSignal }): Promise<ToolOutcome> => {
        try {
          return await handlers[decl.name](args ?? {}, callCtx);
        } catch (error) {
          return { text: `[${decl.name} 失败] ${explain(error, this.ffmpegPath())}`, failed: true };
        }
      },
    }));
  }

  /* ------------------------------------------------------------ video_probe */

  private async probe(args: Args, callCtx?: { signal?: AbortSignal }): Promise<ToolOutcome> {
    const input = String(args.video ?? '').trim();
    if (!input) throw new Error('缺参数 video（B站编号/链接或本地绝对路径）。');

    if (isBili(input) || isHttp(input)) {
      if (isHttp(input) && !isBili(input)) {
        throw new BiliError('目前只支持 B站链接和本地文件。其它站点请先下载到本地，把绝对路径给它。');
      }
      const client = this.client();
      const meta = await client.view(input, Number(args.part ?? 1) || 1, callCtx?.signal);
      const scanHeight = Number(this.cfg().scanHeight) || 480;
      const [play, subtitle] = await Promise.all([
        client.playurl(meta, scanHeight, callCtx?.signal),
        client.subtitles(meta, callCtx?.signal).catch(
          (e): SubtitleInfo => ({ available: false, reason: message(e), segments: [] }),
        ),
      ]);
      /**
       * **音频画像只在本机已有副本时做。**
       *
       * probe 的承诺是"不下载、不出图、不花图片 token"（几毫秒）。
       * 为了听一遍音频去下载几十 MB，等于把 probe 变成 storyboard —— 方向反了。
       *
       * 但"这条是配乐还是口播"恰恰能省下 30–40 秒（实测：两次纯音乐片跑完语音识别
       * 什么都没听到，还丢掉了 4 条幻觉）。所以折中：**缓存里有就听**（零成本），
       * 没有就不听。正文里会因此少一行，那不是缺陷 —— 是 probe 没越界。
       */
      let audio: { kind: string; text: string } | null = null;
      try {
        const engine = await this.engine();
        const cachedPath = join(
          engine.mediaDir(),
          engine.mediaKey(`bilibili:${meta.bvid}:p${meta.part}@${scanHeight}`, scanHeight),
          'video.mp4',
        );
        if (existsSync(cachedPath)) {
          const hint = await audioHint({ input: cachedPath, ffmpegPath: this.ffmpegPath() });
          if (hint) audio = { kind: hint.kind, text: hint.text };
        }
      } catch {
        // 分析失败不该让 probe 失败 —— 它只是锦上添花
      }

      return {
        text: formatBiliProbe({
          meta,
          play,
          subtitle,
          loggedIn: client.loggedIn,
          scanHeight,
          withCookie: Boolean(this.cookie()),
          audio,
        }),
      };
    }

    const engine = await this.engine();
    const info = await engine.probeVideo(input, { ffprobePath: this.ffprobePath() });
    // 本地文件本来就在盘上，直接听 —— 成本可以忽略（一条 3 分钟的音轨约 1 秒）
    let audio: { kind: string; text: string } | null = null;
    try {
      if (info?.hasAudio) {
        const hint = await audioHint({
          input,
          ffmpegPath: this.ffmpegPath(),
          to: Number(info.duration) || undefined,
        });
        if (hint) audio = { kind: hint.kind, text: hint.text };
      }
    } catch {
      /* 同上 */
    }
    return { text: formatLocalProbe(info, input, audio) };
  }

  /* ------------------------------------------------------------ video_storyboard */

  private async storyboard(args: Args, callCtx?: { signal?: AbortSignal }): Promise<ToolOutcome> {
    const cfg = this.cfg();
    const engine = await this.engine();
    const textOnly = args.textOnly === true;

    if (!textOnly) this.ledger.assertAllowed(Number(cfg.maxDailyCalls) || 0, Number(cfg.maxDeliveredMB) || 0);

    const src = await this.prepare(args, engine, { wantFrameSource: false }, callCtx);

    // 长片护栏：没给 from/to/segment 又很长 → 自动按第一段读，结果会打印 next: from=…
    const duration = await this.durationOf(src, engine);
    const explicitWindow = args.from !== undefined || args.to !== undefined || Number(args.segment) > 0;
    const autoSegment = !explicitWindow && duration > LONG_VIDEO_SEC ? Number(cfg.segment) || 300 : undefined;

    const options = engine.boardOptions(
      {
        ...args,
        input: src.localPath,
        detail: args.detail ?? cfg.detail,
        strategy: args.strategy ?? cfg.strategy,
        budget: args.budget ?? cfg.budget,
        maxSheets: args.maxSheets ?? cfg.maxSheets,
        maxFrames: args.maxFrames ?? cfg.maxFrames,
        ...(autoSegment ? { segment: autoSegment } : {}),
        // 有字幕文件就直接用它；没有就明确关掉转写，别让引擎去试 ASR（本版没接）。
        transcript: src.transcriptFile ? 'auto' : 'off',
        ...(src.transcriptFile ? { transcriptFile: src.transcriptFile } : {}),
        // 硬字幕 OCR 需要 Python + PaddleOCR，本版不启用。
        ocr: false,
        textOnly,
      },
      { kind: 'board' },
    );

    const problems = engine.validateToolArgs({ ...args, input: src.localPath });
    if (problems.length) throw new Error(`参数不合法：${problems.join('；')}`);

    if (!textOnly) this.ledger.countCall(); // 失败也记，否则模型重试会把额度刷穿

    const result = await engine.runStoryboard({
      ...options,
      ffmpegPath: this.ffmpegPath(),
      ffprobePath: this.ffprobePath(),
      ...(callCtx?.signal ? { signal: callCtx.signal } : {}),
    });

    /**
     * **给格子表补一个 BV 别名。**
     *
     * 引擎的 `saveCells([inputRaw, input])` 只写进了本地路径 —— 因为 `pipeline` 里的
     * `inputRaw` 在 `resolveInput()` 之后已经是本地路径了，"原始 URL 别名"这条分支
     * 实际上是空的。
     *
     * 而模型下一轮要 `video_zoom({ video: 'BV…', cellId: 7 })` 时手上只有 BV 号，
     * 查不到就只能退回 from/to 手抄时间码 —— 那正是 `cellId` 要消灭的动作。
     * 所以这里按 bvid 再写一份（`cells.json` 本身就是按"键 → 同一张表"存的，
     * 多个键指向同一份 cells 数组，成本只有几 KB）。
     */
    if (!textOnly && src.meta && Array.isArray(result.sheets) && result.sheets.length) {
      try {
        const cells = result.sheets.flatMap((s: any) =>
          (s.cells ?? []).map((c: any) => ({ i: c.i, from: c.t_start, to: c.t_end })),
        );
        if (cells.length) {
          await engine.saveCells([src.localPath, `bilibili:${src.meta.bvid}:p${src.meta.part}`], cells);
        }
      } catch {
        // 别名写不进去只影响"下次用 BV 号寻址"，不该让这次调用失败
      }
    }

    return this.finish(engine, result, src, {
      kind: 'board',
      detail: options.detail,
      cellRange: Array.isArray(args.cellRange) ? (args.cellRange as number[]) : null,
      textOnly,
      maxDeliveredMB: Number(cfg.maxDeliveredMB) || 0,
    });
  }

  /* ------------------------------------------------------------ video_zoom */

  private async zoom(args: Args, callCtx?: { signal?: AbortSignal }): Promise<ToolOutcome> {
    const cfg = this.cfg();
    const engine = await this.engine();
    const cellId = Number.isFinite(Number(args.cellId)) ? Number(args.cellId) : null;
    const hasRange = Number(args.from) >= 0 && Number(args.to) > 0;
    if (cellId === null && !hasRange) {
      throw new Error('zoom 需要 cellId，或者同时给 from 和 to（秒）。');
    }

    this.ledger.assertAllowed(Number(cfg.maxDailyCalls) || 0, Number(cfg.maxDeliveredMB) || 0);

    // 回原始流取高清帧很慢（每次 seek 走 HTTP，实测 4 帧约 40 秒），
    // 而本地 480p 副本对 4 格仍有 2 倍超采样 —— 所以这件事可选，默认关。
    const fromStream = cfg.zoomFromStream !== false;
    const src = await this.prepare(args, engine, { wantFrameSource: fromStream }, callCtx);

    let from = args.from;
    let to = args.to;
    if (cellId !== null) {
      /**
       * **寻址要同时试几个键。**
       *
       * `cells.json` 以**输入字符串**为键。引擎的 `saveCells([inputRaw, input])` 本意是
       * 同时存"URL 和本地路径"两个别名，但 `pipeline` 里的 `inputRaw` 在
       * `resolveInput()` 之后就变成**本地路径**了 —— 所以表里只有本地路径。
       * 模型下一轮拿 BV 号来寻址就查不到。
       *
       * 而模型最常见的用法正是「上一轮跑过 storyboard，这一轮说『第 7 格放大』」，
       * 那时它手上只有 BV 号。所以按优先级试三个键，并在失败时把查过的键写出来
       * （否则这种"明明刚跑过却说没有"的错最难查）。
       */
      const keys = [
        src.localPath,
        String(args.video ?? '').trim(),
        src.meta ? `bilibili:${src.meta.bvid}:p${src.meta.part}` : '',
      ].filter(Boolean);
      let hit: { from: number; to: number; i: number } | null = null;
      for (const key of keys) {
        hit = await engine.lookupCell(key, cellId);
        if (hit) break;
      }
      if (!hit) {
        throw new Error(
          `找不到第 ${cellId} 格：格子表里没有这个键（可能清了缓存、换了清晰度档位，或还没跑过 video_storyboard）。` +
            '先对同一个视频跑一次 video_storyboard，或者直接给 from/to（秒）。' +
            `（查过：${keys.join(' / ')}）`,
        );
      }
      from = hit.from;
      to = hit.to;
    }

    const options = engine.boardOptions(
      {
        ...args,
        input: src.localPath,
        from,
        to,
        detail: args.detail ?? cfg.detail,
        budget: args.budget ?? cfg.budget,
        transcript: src.transcriptFile ? 'auto' : 'off',
        ...(src.transcriptFile ? { transcriptFile: src.transcriptFile } : {}),
        ocr: false,
      },
      { kind: 'zoom', frameSource: src.frameSource },
    );

    const problems = engine.validateZoomArgs({ ...args, input: src.localPath, from, to });
    if (problems.length) throw new Error(`参数不合法：${problems.join('；')}`);

    this.ledger.countCall();

    const result = await engine.runStoryboard({
      ...options,
      ffmpegPath: this.ffmpegPath(),
      ffprobePath: this.ffprobePath(),
      ...(callCtx?.signal ? { signal: callCtx.signal } : {}),
    });

    return this.finish(engine, result, src, {
      kind: 'zoom',
      detail: options.detail,
      cellRange: null,
      textOnly: false,
      maxDeliveredMB: Number(cfg.maxDeliveredMB) || 0,
    });
  }

  /* ------------------------------------------------------------ video_locate */

  /**
   * 纯文本定位。**不出图、不花图片额度**，所以它既不进 `maxDailyCalls` 台账，
   * 也不受那个额度限制 —— 一个"问句话在第几分钟"的调用被额度挡住是荒唐的。
   */
  private async locate(args: Args, callCtx?: { signal?: AbortSignal }): Promise<ToolOutcome> {
    const input = String(args.video ?? '').trim();
    const query = String(args.query ?? '').trim();
    if (!input) throw new Error('缺参数 video（B站编号/链接或本地绝对路径）。');
    if (!query) throw new Error('缺参数 query：要查的那句话。');

    // locate 只读磁盘上的台词，不解码也不联网 —— 所以先解析出 bvid/分P，
    // 但不下载媒体（不调 resolveSource，那会触发下载）。
    const engine = await this.engine();
    const part = Number(args.part ?? 1) || 1;
    let bvid: string | null = null;
    let meta: BiliMeta | null = null;
    if (isBili(input) || isHttp(input)) {
      if (isHttp(input) && !isBili(input)) {
        throw new BiliError('目前只支持 B站链接和本地文件。');
      }
      meta = await this.client().view(input, part, callCtx?.signal);
      bvid = meta.bvid;
    }

    const loaded = bvid
      ? loadTranscript(this.dirs.root, bvid, part, args.transcriptFile as string | undefined)
      : {
        source: 'none' as const,
        segments: [],
        note: '本地文件没有已知的字幕位置；请调 video_storyboard（它会做语音识别并缓存台词）之后再 locate。',
      };

    if (loaded.segments.length === 0) {
      return {
        text: `[transcript] ${loaded.note}`,
        failed: true,
      };
    }

    const from = Number(args.from);
    const to = Number(args.to);
    const ranged = loaded.segments.filter(
      (s) => (!Number.isFinite(from) || s.to > from) && (!Number.isFinite(to) || s.from < to),
    );
    const max = Math.min(20, Math.max(1, Math.round(Number(args.max) || 5)));
    const matches = engine.matchSegments(ranged, query, { max }) as Array<{
      from: number;
      to: number;
      text: string;
      score: number;
    }>;

    const head = `[video] ${meta ? `${meta.title} · ${meta.bvid} p${part}` : input}`;
    const tail = loaded.source === 'asr'
      ? '[依据] 台词来自本地语音识别，专有名词可能错；引用前建议用 video_zoom 对一下画面。'
      : '[依据] 台词来自站点字幕轨。';
    return {
      text: `${head}\n[transcript] ${loaded.note}\n\n${engine.formatMatches(query, matches, { total: ranged.length })}\n\n${tail}`,
    };
  }

  /* ------------------------------------------------------------ video_subtitles */

  /** 硬字幕裁带长图。**出一张图**，所以要过额度。 */
  private async subtitles(args: Args, callCtx?: { signal?: AbortSignal }): Promise<ToolOutcome> {
    const cfg = this.cfg();
    const engine = await this.engine();
    this.ledger.assertAllowed(Number(cfg.maxDailyCalls) || 0, Number(cfg.maxDeliveredMB) || 0);

    const src = await this.prepare(args, engine, { wantFrameSource: false }, callCtx);
    const part = Number(args.part ?? 1) || 1;

    // **这个工具只对"烧进画面"的字幕有意义。**
    //
    // 实测踩过：一条有字幕轨（软字幕，播放器渲染）的番剧，拿去裁底部带，
    // 裁出来的是脚和裙子 —— 因为画面里根本没有字。软字幕是另一回事，
    // 请用 video_locate 或直接在 storyboard 的清单里读。
    //
    // 判据只看"站点有没有字幕轨"：有轨就不该来这里。真正烧死的字幕
    // （PV / 歌词 / 双语艺术字）**没有**字幕轨，所以这个判据不会误伤它们。
    const transcript = src.meta
      ? loadTranscript(this.dirs.root, src.meta.bvid, part, args.transcriptFile as string | undefined)
      : null;
    if (transcript && transcript.source === 'site-subtitle') {
      throw new Error(
        `这条视频有字幕轨（${transcript.segments.length} 句），那些字是**播放器渲染的软字幕**，` +
          '不在画面像素里 —— 裁底部只会裁到画面本身。要读台词请用：\n' +
          `  video_locate({ video: "${src.meta?.bvid}", query: "那句话" })   ← 纯文本，零图片 token\n` +
          '或者直接看 video_storyboard 清单里逐格贴好的台词。\n' +
          '（video_subtitles 只适合字幕**烧死**在画面里的片子：PV、歌词、双语艺术字，那种没有字幕轨。）',
      );
    }

    // 有真实台词时间码就按它对齐（一条对应一句，省一半条数）；
    // 没有就让引擎均匀抽样 —— 拿不可靠的时刻表去"精确"对齐只会越对越错。
    let times: number[] | null = null;
    if (transcript && transcript.source === 'asr' && transcript.segments.length) {
      // ASR 的时间码**不能**用来对齐烧死字幕（实测：唱歌/纯音乐片上它漏掉大半，
      // 越对越错）。这里只把它当"这条片子确实有台词"的信息，不对齐。
      times = null;
    }

    const band = Array.isArray(args.band) && args.band.length === 2
      ? (args.band as number[])
      : engine.defaultBand;

    const outPath = join(this.dirs.state, 'subtitle-strip.png');

    this.ledger.countCall();
    const { readFile } = await import('node:fs/promises');
    const strip = await engine.buildSubtitleStrip({
      input: src.localPath,
      ffmpegPath: this.ffmpegPath(),
      ffprobePath: this.ffprobePath(),
      from: Number(args.from) || 0,
      ...(Number(args.to) > 0 ? { to: Number(args.to) } : {}),
      maxStrips: Math.min(40, Math.max(1, Math.round(Number(args.maxStrips) || 24))),
      stepSec: Number(args.stepSec) > 0 ? Number(args.stepSec) : 3,
      band,
      out: outPath,
      ...(times ? { times } : {}),
    });

    const png = await readFile(strip.out);
    const bytes = png.byteLength;

    const marks = strip.strips.map((s: { t: number }) => clock(s.t)).join(' ');
    const head = [
      `[video] ${src.title} · ${src.identity}`,
      `[strips] ${strip.strips.length} 条 · 带区间 ${band[0].toFixed(2)}-${band[1].toFixed(2)}` +
        `（${strip.bandSource === 'detected' ? '自动检测' : '默认底部带'}）`,
      `[order] 从上到下依次是：${marks}`,
      '[align] 按时间均匀抽样 —— 拿 ASR 的时间码去对齐烧死字幕会越对越错（唱歌/纯音乐片漏掉大半）。',
    ];

    if (Number(cfg.maxDeliveredMB) > 0 && this.ledger.deliveredMB + bytes / 1048576 > Number(cfg.maxDeliveredMB)) {
      return {
        text: `${head.join('\n')}\n\n[图片未附] 累计交付预算已用完（${mb(this.ledger.deliveredMB)}MB/${cfg.maxDeliveredMB}MB）。`,
      };
    }
    this.ledger.countDelivered(bytes);

    return {
      text: `${head.join('\n')}\n\n[怎么读] 每一条就是某个时刻画面底部那一条字幕。空白条 = 那一刻屏幕上没有字幕（也是信息）。` +
        `如果文字被裁掉了上半截，把 band 的 y0 调小；如果一条里大半是空画面，把 y0 调大。` +
        '\n[依据] 这是**画面像素里**的字幕。如果每一条里都没有字，说明这条字幕是播放器渲染的软字幕、' +
        '不在画面里 —— 那就该用 video_locate 或 storyboard 的台词，别再裁了。' +
        (src.play ? `\n[resolution] 裁带用的是 ${src.play.height}p 副本。` : ''),
      blobs: [
        {
          bytes: png,
          mime: 'image/png',
          name: 'subtitle-strip.png',
          fallbackText: `烧死字幕长图 ${strip.strips.length} 条`,
        },
      ],
    };
  }

  /* ------------------------------------------------------------ 共用 */

  private async prepare(
    args: Args,
    engine: Engine,
    o: { wantFrameSource: boolean },
    callCtx?: { signal?: AbortSignal },
  ): Promise<PreparedSource> {
    const cfg = this.cfg();
    return resolveSource({
      input: String(args.video ?? '').trim(),
      part: Number(args.part ?? 1) || 1,
      height: Number(cfg.scanHeight) || 480,
      wantFrameSource: o.wantFrameSource,
      frameHeight: Number(cfg.zoomHeight) || 1080,
      client: this.client(),
      engine,
      dataDir: this.dirs.root,
      ffmpeg: this.ffmpegPath(),
      ffprobe: this.ffprobePath(),
      ...(callCtx?.signal ? { signal: callCtx.signal } : {}),
      ...(typeof args.transcriptFile === 'string' && args.transcriptFile.trim()
        ? { transcriptFile: args.transcriptFile.trim() }
        : {}),
      // **没有字幕轨时的兜底**。每次调用都重新解析一遍：配置是活引用，
      // 主人刚把模型目录填好，下一次工具调用就该用上。
      asr: resolveAsrConfig({
        // 这里要的是**部署** dataDir（要一路爬到 D:\Coopanion 去找 resources/app），
        // 不是私有根 —— 给私有根只会多爬两层，脆在'爬几层'这个假设上。
        dataDir: this.ctx.dataDir,
        mode: String(cfg.asrMode ?? 'auto'),
        modelDir: String(cfg.asrModelDir ?? ''),
        sherpaPath: String(cfg.asrSherpaPath ?? ''),
        language: String(cfg.asrLanguage ?? 'auto'),
        apiUrl: String(cfg.asrApiUrl ?? ''),
        apiKey: String(cfg.asrApiKey ?? ''),
        apiModel: String(cfg.asrApiModel ?? ''),
      }),
      asrSherpaPath: String(cfg.asrSherpaPath ?? ''),
    });
  }

  private async durationOf(src: PreparedSource, engine: Engine): Promise<number> {
    if (src.meta) return src.meta.partDuration || src.meta.duration;
    try {
      const info = await engine.probeVideo(src.localPath, { ffprobePath: this.ffprobePath() });
      return Number(info?.duration) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * 把引擎的结果变成宿主认得的东西：**一段文本 + 若干张图**。
   *
   * 文本前面那几行是刻意加的：引擎的清单只描述画面本身，
   * 而"这份副本是新下的还是命中的、字幕是从哪来的、清晰度有没有被降级"——
   * 这几件事决定了模型敢不敢引用，必须由本 World 说清楚。
   */
  private async finish(
    engine: Engine,
    result: any,
    src: PreparedSource,
    o: {
      kind: 'board' | 'zoom';
      detail: string;
      cellRange: number[] | null;
      textOnly: boolean;
      maxDeliveredMB: number;
    },
  ): Promise<ToolOutcome> {
    const head: string[] = [];
    head.push(
      `[video] ${src.title} · ${src.identity} · ${clock(await this.durationOf(src, engine))}`,
    );
    if (o.kind === 'zoom') {
      // zoom 的帧可能来自两个地方，结果里必须说清是哪一个 ——
      // 它决定了"画面上的小字能不能读"这件事到底成不成立。
      head.push(
        src.frameSource
          ? `[frames] 按帧读原始流 ${src.frameSource.height}p（没有下载）；本地 ${src.play?.height ?? '?'}p 副本只作回落`
          : `[frames] 从本地 ${src.play?.height ?? '?'}p 副本读（配置里关了"回原始流取帧"）` +
            '；要读画面上的小字，请主人在配置页打开它。',
      );
    } else if (src.play) {
      head.push(
        `[resolution] got ${src.play.height ?? '?'}p (asked ${src.play.requestedHeight}p)` +
          (src.degraded.length ? ` — ${src.degraded.join('; ')}` : ''),
      );
    } else {
      head.push('[resolution] local file, read at its own resolution');
    }
    head.push(`[transcript] ${src.transcriptNote}`);
    head.push(`[cache] ${src.downloaded ? '新下载了一份本地副本' : '命中本地副本（没有重新下载）'}`);
    if (src.hasAudio === false) head.push('[audio] 这份副本没有音轨；底部波条不会出现。');

    /**
     * **台词密度太低时主动说一句。**
     *
     * 实测踩过：《一等情事》217 秒、没有字幕轨，语音识别转了 5 个切片、
     * 丢弃 4 条音乐段幻觉，最后只捞回 **1 句 31 字**（0.14 字/秒）。
     *
     * 那 12 秒的识别劳动本身没错，错在**结果没说清它意味着什么**：
     * 模型看到 `[transcript] 转写了 5 个切片…1 句`，很容易以为"有台词可以引用"，
     * 于是把一条画面/音乐驱动的片子当口播内容分析 —— 它的评论就建立在
     * 31 个可能还听错的字上了。
     *
     * 判据不猜：直接用引擎算好的 `charsPerSec`（台词总字数 ÷ 窗口时长）。
     * 低于 0.5 = 基本没有说话；0 = 一句都没有。正常口播（2 字/秒以上）不吭声。
     */
    const tr = (result as any)?.transcript;
    const cps = Number(tr?.charsPerSec);
    if (Number.isFinite(cps) && cps === 0) {
      head.push('[台词密度] 这个窗口里一个字都没有 —— 纯画面 / 纯音乐片，别等台词。');
    } else if (Number.isFinite(cps) && cps > 0 && cps < 0.5) {
      head.push(
        `[台词密度] 只有 ${Number(tr?.chars) || '?'} 字、${cps.toFixed(2)} 字每秒 —— **这条几乎没有可读的台词**。` +
          '它更像是画面或音乐驱动的片子，别把它当口播内容分析。' +
          '要判断"这片子好在哪"，看格子和切点密度，而不是这几句词。',
      );
    }

    /**
     * **必须压到宿主的告警线以下。**
     *
     * 宿主对单次工具回执的上限是 8000 字符（`core/loop.ts` 的 `LARGE_RESULT_WARN_CHARS`），
     * 超过只在日志里 warn、不截断 —— 但那是真金白银的 token。
     *
     * 实测踩过两次：
     *   1. 鱼闲逛时调 `video_storyboard({ maxFrames: 60 })`，拿到 **9807 字**；
     *   2. 同一支歌（**双语字幕**，中英各一行）在 maxFrames:60 下 **12176 字** ——
     *      `maxCellChars` 是 120 字，但那是按字符数的，双语等于每格翻倍。
     *
     * 所以这里不只给 maxChars 兜底，还在**总长仍超标**时自动把 `detail` 降一档再渲染一次。
     * 降档只影响每格贴多少台词（120→60 字），画面和格号一个不变 ——
     * 而模型真正需要引用的是「第几格 + 什么时间」，不是每格贴满整段字幕。
     * 截断仍然落在句末、仍然写清 `cellRange` 续读方式，所以不丢内容。
     */
    const BODY_BUDGET = 7000;
    const render = (detail: string) => engine.formatForDetail(result, {
      detail,
      cellRange: o.cellRange,
      maxChars: BODY_BUDGET,
    });

    let body = render(o.detail);
    let usedDetail = o.detail;
    // 降档序列：med→low；high→med→low。**只降台词量，不降画面**。
    const ladder: Record<string, string[]> = { high: ['high', 'med', 'low'], med: ['med', 'low'], low: ['low'] };
    for (const next of (ladder[o.detail] ?? ['low']).slice(1)) {
      if (body.length <= BODY_BUDGET) break;
      body = render(next);
      usedDetail = next;
    }

    const footer = o.textOnly || !result?.sheets?.length
      ? '[依据] 本次只有文本索引，没有出图。'
      : '[依据] 以上是「画面（这些格）＋字幕」的直接观察（evidence=video|subtitle）。' +
        '引用时请带上格号与时间；画面之外的事不要当成看到过。';

    // 真的降了才说 —— 否则每格都白写一句「我没降」
    if (usedDetail !== o.detail) {
      head.push(
        `[detail] 回执太长，每格台词已从 '${o.detail}' 降到 '${usedDetail}'（画面与格号不变）。` +
        '要读某一格的完整台词，用 video_storyboard({ ..., cellRange: [n, n], textOnly: true }) 只取那一格。',
      );
    }

    const text = `${head.join('\n')}\n\n${body}\n\n${footer}`;

    const sheets: any[] = Array.isArray(result?.sheets) ? result.sheets : [];
    if (o.textOnly || !sheets.length) return { text };

    const bytes = sheets.reduce((n, s) => n + (s?.png?.length ?? 0), 0);
    if (o.maxDeliveredMB > 0 && this.ledger.deliveredMB + bytes / 1048576 > o.maxDeliveredMB) {
      return {
        text:
          `${text}\n\n[图片未附] 累计交付预算已用完（${mb(this.ledger.deliveredMB)}MB/${o.maxDeliveredMB}MB）；` +
          '这次只给文本索引。可以让主人在配置页提高预算。',
      };
    }
    this.ledger.countDelivered(bytes);

    const blobs = sheets.map((s) => ({
      bytes: s.png as Uint8Array,
      mime: 'image/png',
      name: `storyboard-${s.sheet ?? 0}.png`,
      fallbackText: `视频分镜图 ${s.sheet ?? '?'}/${sheets.length}（${s.width}x${s.height}）`,
    }));

    return { text, blobs };
  }

  /* ------------------------------------------------------------ WebUI */

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const en = language !== 'zh';
    const cfg = this.cfg();
    const ffmpegOk = this.ffmpegReady();
    const loggedIn = Boolean(this.cookie());
    const sizes = this.dirSizes();

    return {
      label: en ? 'Video Reader' : '视频读懂',
      lamps: [
        {
          label: en ? 'FFmpeg' : 'ffmpeg',
          state: ffmpegOk ? 'online' : 'error',
          hint: ffmpegOk ? this.ffmpegPath() : `${en ? 'not runnable' : '跑不起来'}：${this.ffmpegPath()}`,
        },
        {
          label: en ? 'Login' : '登录',
          state: loggedIn ? 'online' : 'offline',
          hint: loggedIn
            ? en ? 'shares the social plugin session' : '已共享社交视窗的 B站登录'
            : en ? 'anonymous; low resolution only' : '匿名：只有低清晰度',
        },
      ],
      badges: [
        {
          label: en ? 'Today' : '今日出图',
          value: `${this.ledger.calls}/${Number(cfg.maxDailyCalls) || 0}`,
          tone: this.ledger.calls >= (Number(cfg.maxDailyCalls) || 0) ? 'off' : 'plain',
        },
        {
          label: en ? 'Delivered' : '累计交付',
          value: `${mb(this.ledger.deliveredMB)}MB`,
          tone: 'plain',
        },
      ],
      /**
       * **不声明 `panels`。**
       *
       * 自定义面板要求包里有前端构建产物 `dist/webui.js`（由 `cortico.webUiClient` 指过去），
       * 否则页签会直接报「缺少面板构建产物」—— 实测就是这么炸的：
       * 一个只有 title/description、没有 getMethods 的 panel，用户点进去只看到红字。
       *
       * 而本 World 要显示的东西（用量、缓存占用、清理）**Core 的内置渲染已经全覆盖**：
       * `badges` 显示用量，`storage` 显示体积并可清除，`config` 自动生成表单，
       * `promptDocs` 渲染环境说明。多写一个面板等于多养一份要构建的前端产物，
       * 换来的只是把这几行数字换个地方摆 —— 不值得。
       */
      config: [VIDEO_READER_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.video-reader.envPrompt',
          title: en ? 'Video Reader · environment' : '视频读懂 · 环境说明',
          description: en
            ? 'How to read video, and where the boundary with the social plugin is.'
            : '怎么看视频，以及与社交视窗的分工边界。',
          path: ENV_PROMPT_PATH,
          role: 'envPrompt',
          vars: [
            { name: 'videoreader.login', description: '登录来源与是否已登录。' },
            { name: 'videoreader.ffmpeg', description: 'ffmpeg 是否可用。' },
            { name: 'videoreader.quota', description: '今日出图次数与累计交付量。' },
          ],
        },
      ],
      storage: [
        {
          key: 'media',
          label: en ? 'Downloaded copies and scan cache' : '下载副本与扫描缓存',
          kind: 'disk',
          location: this.dirs.media,
          note: en
            ? 'Deleting them only means the next read downloads again; the usage ledger is not reset.'
            : '删掉只意味着下次读要重新下载；用量账本不会因此重置。',
          stat: () =>
            `${(sizes.media / 1048576).toFixed(1)} MB ${en ? 'media' : '媒体'} / ` +
            `${(sizes.cache / 1048576).toFixed(1)} MB ${en ? 'scan cache' : '扫描缓存'} · ` +
            this.ledger.describe(),
          clear: async () => {
            let freed = 0;
            for (const dir of [this.dirs.media, this.dirs.cache]) {
              freed += dirSize(dir);
              rmSync(dir, { recursive: true, force: true });
            }
            this.sizeCache = { at: 0, media: 0, cache: 0 };
            return en
              ? `Removed ${(freed / 1048576).toFixed(1)} MB. The next read downloads again.`
              : `已清掉 ${(freed / 1048576).toFixed(1)} MB；下次读会重新下载。`;
          },
        },
        {
          // 字幕单独一项：它是**再拿一次就免费的**东西（B站字幕轨），但删掉之后
          // 同一条视频会退回"没有台词"，所以值得单独标出来好让人知道它在哪。
          key: 'transcripts',
          label: en ? 'Saved subtitle tracks' : '已保存的字幕轨',
          kind: 'disk',
          location: this.dirs.transcripts,
          note: en
            ? 'One JSON per video part, taken from the site subtitle track. Deleting one only means it is fetched again.'
            : '每条视频分P 一个 JSON，取自 B站字幕轨。删掉只意味着下次读会重新取一遍。',
          stat: () => {
            const dir = this.dirs.transcripts;
            const n = fileCount(dir);
            return n === 0
              ? (en ? 'none yet' : '还没有')
              : en ? `${n} file(s), ${(dirSize(dir) / 1048576).toFixed(1)} MB` : `${n} 个，共 ${(dirSize(dir) / 1048576).toFixed(1)} MB`;
          },
          clear: async () => {
            const dir = this.dirs.transcripts;
            const n = fileCount(dir);
            rmSync(dir, { recursive: true, force: true });
            return en ? `Removed ${n} file(s).` : `已删掉 ${n} 个字幕文件。`;
          },
        },
      ],
    };
  }

  private dirSizes(): { media: number; cache: number } {
    const now = Date.now();
    if (now - this.sizeCache.at < 30_000) return this.sizeCache;
    this.sizeCache = {
      at: now,
      media: dirSize(this.dirs.media),
      cache: dirSize(this.dirs.cache),
    };
    return this.sizeCache;
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 把底层报错翻成"照着做就能解决"的一句话。 */
function explain(error: unknown, ffmpegPath: string): string {
  const msg = message(error);
  if (/ENOENT/i.test(msg) && /ffmpeg|ffprobe/i.test(msg)) {
    return (
      `这台机器上找不到 ffmpeg/ffprobe（当前取的是 ${ffmpegPath}）。` +
      '装好后加进 PATH，或在「视频读懂」配置页把两个路径填成绝对路径。' +
      'Windows 可从 gyan.dev 下 ffmpeg-release-essentials.zip，解压后填 ...\\bin\\ffmpeg.exe 和 ...\\bin\\ffprobe.exe。'
    );
  }
  if (/EPERM|EACCES/i.test(msg)) {
    return `${msg} —— 目标文件被占用或没有写权限；换一个缓存目录或关掉正在读这个文件的程序。`;
  }
  if (error instanceof BiliError && error.kind === 'auth') {
    return `${msg} —— 登录可能过期了。在社交视窗面板重新扫码即可，本扩展会立刻用上新的 cookie。`;
  }
  if (error instanceof BiliError && error.kind === 'rate') {
    return `${msg} —— B站风控/限流。等一会儿再试，不要连续重试。`;
  }
  return msg;
}

/** 供测试使用。 */
export { explain as explainToolError };
