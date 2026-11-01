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
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Language, ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { WorldContext } from 'cortico/world.ts';

import { VIDEO_READER_CONFIG_GROUP, VIDEO_READER_ID, type VideoReaderConfigSection } from './config.ts';
import { VIDEO_READER_TOOL_DECLS } from './tools.ts';
import { applyEngineEnv, loadEngine, type Engine } from './engine/load.js';
import { BiliError, BilibiliClient, type SubtitleInfo } from './bridge/bilibili.ts';
import { resolveSource, type PreparedSource } from './bridge/source.ts';
import { UsageLedger } from './bridge/usage.ts';
import { formatBiliProbe, formatLocalProbe, clock } from './bridge/probe-text.ts';

const ENV_PROMPT_PATH = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

type Args = Record<string, unknown>;

const isHttp = (v: string) => /^https?:\/\//i.test(v);
const isBili = (v: string) => /bilibili\.com/i.test(v) || /^(BV[0-9A-Za-z]{10}|av\d{1,20})$/i.test(v.trim());

/** 体积显示：小数值保留一位，免得 0.2MB 显示成 "0MB"。 */
const mb = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));

/** 长于这个秒数、又没给 from/to/segment 时，自动按窗口读第一段 —— 免得一上手就烧完整片。 */
const LONG_VIDEO_SEC = 1200;

export class VideoReaderWorld implements World {
  readonly id = VIDEO_READER_ID;
  private host: WorldHost | null = null;
  private readonly ledger: UsageLedger;
  private lastError: string | null = null;
  /** ffmpeg 自检结果缓存：WebUI 每次渲染都问，不能每次都起一个进程。 */
  private ffprobeCheck: { at: number; ok: boolean } = { at: 0, ok: false };
  /** 缓存目录体积缓存（同上）。 */
  private sizeCache: { at: number; media: number; cache: number } = { at: 0, media: 0, cache: 0 };

  constructor(private readonly ctx: WorldContext<VideoReaderConfigSection>) {
    this.ledger = new UsageLedger(join(ctx.dataDir, 'state'), ctx.timezone);
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
      dataDir: this.ctx.dataDir,
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
      return {
        text: formatBiliProbe({
          meta,
          play,
          subtitle,
          loggedIn: client.loggedIn,
          scanHeight,
          withCookie: Boolean(this.cookie()),
        }),
      };
    }

    const engine = await this.engine();
    const info = await engine.probeVideo(input, { ffprobePath: this.ffprobePath() });
    return { text: formatLocalProbe(info, input) };
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

    return this.finish(engine, result, src, {
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

    const src = await this.prepare(args, engine, { wantFrameSource: true }, callCtx);

    let from = args.from;
    let to = args.to;
    if (cellId !== null) {
      const hit = await engine.lookupCell(src.localPath, cellId);
      if (!hit) {
        throw new Error(
          `找不到第 ${cellId} 格：这张格子表不在缓存里（可能换了清晰度、或还没跑过 video_storyboard）。` +
            '先对同一个视频跑一次 video_storyboard，或者直接给 from/to（秒）。',
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
      detail: options.detail,
      cellRange: null,
      textOnly: false,
      maxDeliveredMB: Number(cfg.maxDeliveredMB) || 0,
    });
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
      dataDir: this.ctx.dataDir,
      ffmpeg: this.ffmpegPath(),
      ffprobe: this.ffprobePath(),
      ...(callCtx?.signal ? { signal: callCtx.signal } : {}),
      ...(typeof args.transcriptFile === 'string' && args.transcriptFile.trim()
        ? { transcriptFile: args.transcriptFile.trim() }
        : {}),
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
    o: { detail: string; cellRange: number[] | null; textOnly: boolean; maxDeliveredMB: number },
  ): Promise<ToolOutcome> {
    const head: string[] = [];
    head.push(
      `[video] ${src.title} · ${src.identity} · ${clock(await this.durationOf(src, engine))}`,
    );
    if (src.play) {
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

    const body = engine.formatForDetail(result, {
      detail: o.detail,
      cellRange: o.cellRange,
    });

    const footer = o.textOnly || !result?.sheets?.length
      ? '[依据] 本次只有文本索引，没有出图。'
      : '[依据] 以上是「画面（这些格）＋字幕」的直接观察（evidence=video|subtitle）。' +
        '引用时请带上格号与时间；画面之外的事不要当成看到过。';

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
      panels: [
        {
          id: 'media',
          title: en ? 'Media & budget' : '媒体与预算',
          description: en
            ? 'What is cached on disk and what has been spent today. Files are evicted by least-recent use.'
            : '本地缓存了什么、今天花了多少。下载的片子按最近使用淘汰，不会无限增长。',
        },
      ],
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
          location: join(this.ctx.dataDir, 'media'),
          note: en
            ? 'Deleting them only means the next read downloads again; the usage ledger is not reset.'
            : '删掉只意味着下次读要重新下载；用量账本不会因此重置。',
          stat: () =>
            `${(sizes.media / 1048576).toFixed(1)} MB ${en ? 'media' : '媒体'} / ` +
            `${(sizes.cache / 1048576).toFixed(1)} MB ${en ? 'scan cache' : '扫描缓存'} · ` +
            this.ledger.describe(),
          clear: async () => {
            let freed = 0;
            for (const dir of [join(this.ctx.dataDir, 'media'), join(this.ctx.dataDir, 'cache')]) {
              freed += dirSize(dir);
              rmSync(dir, { recursive: true, force: true });
            }
            this.sizeCache = { at: 0, media: 0, cache: 0 };
            return en
              ? `Removed ${(freed / 1048576).toFixed(1)} MB. The next read downloads again.`
              : `已清掉 ${(freed / 1048576).toFixed(1)} MB；下次读会重新下载。`;
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
      media: dirSize(join(this.ctx.dataDir, 'media')),
      cache: dirSize(join(this.ctx.dataDir, 'cache')),
    };
    return this.sizeCache;
  }
}

/* ------------------------------------------------------------------ 工具 */

/** 目录体积，**有上限地**走：只为了在面板上显示一个数量级，不值得遍历几万个文件。 */
function dirSize(dir: string, budget = 4000): number {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < budget) {
    const cur = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of names) {
      if (seen >= budget) break;
      const p = join(cur, name);
      try {
        const st = statSync(p);
        seen += 1;
        if (st.isDirectory()) stack.push(p);
        else total += st.size;
      } catch {
        /* 走到一半被删了：跳过 */
      }
    }
  }
  return total;
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
