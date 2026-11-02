/**
 * bridge/bilibili.ts — B站链路：BV 号 → 元信息 / 取流 / 字幕 / 落盘。
 *
 * ## 为什么自己调接口，而不是走 yt-dlp
 *
 * 1. **清晰度**：社交视窗用 `qn:16`（360P）取流，所以画面糊；这里用 `qn:80`（1080P）。
 *    只要机器上有登录 cookie，这一步就能拿到原画。
 * 2. **不落第二份依赖**：yt-dlp 要用户自己装、要自己导 cookies.txt，
 *    而 cookie 本来就在社交视窗的 secret 里躺着。
 * 3. **字幕**：B站的 CC 字幕 JSON 是 `{body:[{from,to,content}]}`，
 *    引擎的 transcript-file 原生认这个格式 —— 有字幕就完全不用跑 ASR。
 *
 * ## 两条硬约束（都是实打实踩过的）
 *
 * - **cid 可能超出 JS 安全整数**，`JSON.parse` 会静默变成错的值。
 *   所以响应体先用正则把 16 位以上的整数转成字符串再 parse（同社交视窗的做法）。
 * - **CDN 校验 UA 和 Referer**，缺一个就 403。全部请求和 ffmpeg 取帧都要带上。
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const API = 'https://api.bilibili.com';
const PASSPORT = 'https://passport.bilibili.com';
export const REFERER = 'https://www.bilibili.com/';
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** WBI 签名用的重排表。B站前端公开的常数，不是密钥。 */
const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

export class BiliError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'rate' | 'network' | 'invalid' | 'rejected' = 'invalid') {
    super(message);
    this.name = 'BiliError';
  }
}

/**
 * 把 16 位以上的整数在 JSON.parse 之前变成字符串。
 * cid / aid 真的会超过 2^53，直接 parse 会拿到一个**看起来正常但已经错**的数。
 */
export function parsePlatformJson(text: string): any {
  return JSON.parse(
    text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) =>
      /^-?\d{16,}$/.test(token) ? JSON.stringify(token) : token,
    ),
  );
}

/** 从 BV 号 / av 号 / 完整链接里取出编号。 */
export function videoId(input: string): string {
  let value = String(input ?? '').trim();
  if (/^https?:/i.test(value)) {
    let u: URL;
    try {
      u = new URL(value);
    } catch {
      throw new BiliError('这不是一个完整的链接。B站短链接（b23.tv）请先在浏览器里展开。');
    }
    if (!['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(u.hostname)) {
      throw new BiliError('这是 B站之外的链接。本扩展目前只认 B站视频；本地文件请直接给绝对路径。');
    }
    // /video/BV.../ 、/video/av123 、/list/... 都取第二段
    value = u.pathname.split('/').filter(Boolean)[1] ?? '';
  }
  if (!/^(BV[0-9A-Za-z]{10}|av\d{1,20})$/i.test(value)) {
    throw new BiliError('视频编号无效：只认 BV 号、av 号或 B站完整视频链接。');
  }
  return value.startsWith('av') || value.startsWith('AV') ? 'av' + value.slice(2) : value;
}

export interface BiliPart {
  cid: string;
  page: number;
  title: string;
  duration: number;
}

export interface BiliMeta {
  bvid: string;
  aid: string;
  cid: string;
  part: number;
  title: string;
  author: string;
  description: string;
  /** 整支视频的时长（不是当前分P的）。 */
  duration: number;
  /** 当前分P的时长。 */
  partDuration: number;
  cover: string;
  url: string;
  parts: BiliPart[];
}

export interface DashTrack {
  url: string;
  backupUrls: string[];
  width?: number;
  height?: number;
  bandwidth?: number;
  codecs?: string;
  codecid?: number;
  id?: number;
  mimeType?: string;
}

export interface PlayInfo {
  /** 本次实际能拿到的画质列表，低→高。 */
  qualityIds: number[];
  qualityLabels: string[];
  videos: DashTrack[];
  audios: DashTrack[];
  /** 没有 DASH 时的渐进式单文件。 */
  progressive: string | null;
  /** 本次选的档位（真实拿到的，不一定等于请求的）。 */
  height: number | null;
  requestedHeight: number;
  /** 请求了 1080 却只拿到 480 之类的降级说明。 */
  degraded: string[];
}

export interface TranscriptSegment {
  from: number;
  to: number;
  text: string;
}

export interface SubtitleInfo {
  available: boolean;
  reason?: string;
  lang?: string;
  langDoc?: string;
  segments: TranscriptSegment[];
  /** B站原始 JSON，直接喂给引擎的 transcriptFile 最省事。 */
  raw?: unknown;
}

/**
 * 一个 B站账号视角的客户端。cookie 用**回调**而不是快照：
 * 社交视窗可能在这中间重新扫码登录，回调能立刻读到新的值。
 */
export class BilibiliClient {
  private wbiKey: { key: string; at: number } | null = null;

  constructor(
    private readonly cookie: () => string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  get loggedIn(): boolean {
    return Boolean(this.cookie());
  }

  private headers(withCookie: boolean, extra?: Record<string, string>): Headers {
    const h = new Headers({
      'User-Agent': USER_AGENT,
      Referer: REFERER,
      Accept: 'application/json, text/plain, */*',
      ...(extra ?? {}),
    });
    const c = this.cookie();
    if (withCookie && c) h.set('Cookie', c);
    return h;
  }

  /** 原始请求。**不跟随重定向**：B站的登录跳转会伪装成 200，跟过去只会拿到一个错的结果。 */
  private async raw(
    url: string,
    init: RequestInit = {},
    signal?: AbortSignal,
    withCookie = true,
  ): Promise<any> {
    const timeout = AbortSignal.timeout(20_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        headers: { ...Object.fromEntries(this.headers(withCookie)), ...Object.fromEntries(new Headers(init.headers)) },
        redirect: 'error',
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) throw new BiliError('操作已取消。', 'network');
      throw new BiliError('B站连接中断或超时。检查网络/代理后再试，不要反复重试。', 'network');
    }
    if (!response.ok) {
      const kind = [412, 429].includes(response.status) ? 'rate' : 'network';
      throw new BiliError(`B站返回 HTTP ${response.status}`, kind as BiliError['kind']);
    }
    const text = await response.text();
    if (text.length > 8 * 1024 * 1024) throw new BiliError('B站响应过大。', 'network');
    try {
      return parsePlatformJson(text);
    } catch {
      throw new BiliError('B站响应不是合法 JSON（可能被风控拦截）。', 'network');
    }
  }

  /** 走 api.bilibili.com 的接口，统一判 `code`。 */
  private async api(
    path: string,
    params: Record<string, string | number> = {},
    signal?: AbortSignal,
    withCookie = true,
  ): Promise<any> {
    const url = new URL(path, API);
    if (![API, PASSPORT].includes(url.origin)) throw new BiliError('请求目标无效。');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const data = await this.raw(url.href, {}, signal, withCookie);
    if (data.code !== 0) {
      const kind = [-101, -111].includes(data.code)
        ? 'auth'
        : [-352, -412, -509, 12051].includes(data.code)
          ? 'rate'
          : 'rejected';
      throw new BiliError(`B站返回 ${data.code}：${String(data.message ?? '请求未获准').slice(0, 120)}`, kind);
    }
    return data.data ?? {};
  }

  /**
   * WBI 签名。B站对播放地址一类的接口要求签名；不签也能试，
   * 但一旦被风控拦下来，报的是"请求未获准"，很难往签名上想。
   */
  private async signed(params: Record<string, string | number>, signal?: AbortSignal): Promise<Record<string, string | number>> {
    if (!this.wbiKey || Date.now() - this.wbiKey.at > 6 * 3600_000) {
      const nav = await this.raw(`${API}/x/web-interface/nav`, {}, signal, false);
      const d = nav?.data ?? {};
      const original = ['img_url', 'sub_url']
        .map((k) => String(d.wbi_img?.[k] ?? '').split('/').pop()?.split('.')[0] ?? '')
        .join('');
      if (original.length !== 64) throw new BiliError('无法取得 B站请求签名（导航接口没返回 wbi 图）。', 'network');
      this.wbiKey = { key: MIXIN.map((i) => original[i]).join('').slice(0, 32), at: Date.now() };
    }
    const p: Record<string, string | number> = { ...params, wts: Math.floor(Date.now() / 1000) };
    const query = Object.keys(p)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
      .join('&');
    return { ...p, w_rid: createHash('md5').update(query + this.wbiKey.key).digest('hex') };
  }

  private async wbiApi(path: string, params: Record<string, string | number>, signal?: AbortSignal): Promise<any> {
    return this.api(path, await this.signed(params, signal), signal);
  }

  /** 元信息 + 分P 表。 */
  async view(input: string, part = 1, signal?: AbortSignal): Promise<BiliMeta> {
    const id = videoId(input);
    const d = await this.api(
      '/x/web-interface/view',
      id.startsWith('BV') ? { bvid: id } : { aid: id.slice(2) },
      signal,
    );
    const pages: BiliPart[] = (d.pages ?? []).map((p: any) => ({
      cid: String(p.cid),
      page: Number(p.page) || 1,
      title: String(p.part ?? '').slice(0, 160),
      duration: Number(p.duration) || 0,
    }));
    const idx = Math.min(Math.max(1, Math.trunc(part) || 1), Math.max(1, pages.length)) - 1;
    const cur = pages[idx];
    if (!cur) throw new BiliError(`该视频没有第 ${part} 集（共 ${pages.length} 集）。`);
    return {
      bvid: String(d.bvid),
      aid: String(d.aid),
      cid: cur.cid,
      part: idx + 1,
      title: String(d.title ?? '').slice(0, 200),
      author: String(d.owner?.name ?? '').slice(0, 80),
      description: String(d.desc ?? '').slice(0, 4000),
      duration: Number(d.duration) || cur.duration,
      partDuration: cur.duration,
      cover: String(d.pic ?? ''),
      url: `https://www.bilibili.com/video/${d.bvid}?p=${idx + 1}`,
      parts: pages,
    };
  }

  /**
   * 取流地址。`height` 是我们想要的上限，实际能拿到多少由账号权限决定 ——
   * 拿不到就在 `degraded` 里说清楚，绝不假装成功。
   */
  async playurl(meta: BiliMeta, height: number, signal?: AbortSignal): Promise<PlayInfo> {
    const qn = height >= 1080 ? 80 : height >= 720 ? 64 : height >= 480 ? 32 : 16;
    const d = await this.api(
      '/x/player/playurl',
      { bvid: meta.bvid, cid: meta.cid, qn, fnval: 4048, fourk: 1, platform: 'pc' },
      signal,
    );

    const qualityIds: number[] = (d.accept_quality ?? []).map(Number).filter((n: number) => Number.isFinite(n));
    const qualityLabels: string[] = (d.accept_description ?? []).map(String);
    const videos: DashTrack[] = (d.dash?.video ?? []).map(mapTrack);
    const audios: DashTrack[] = (d.dash?.audio ?? []).map(mapTrack);
    const progressive = d.durl?.[0]?.url ? String(d.durl[0].url) : null;

    const degraded: string[] = [];
    let picked: DashTrack | null = null;
    if (videos.length) {
      const under = videos.filter((v) => (v.height ?? 0) <= height);
      const pool = under.length ? under : videos;
      picked = pickBest(pool);
    }
    const got = picked?.height ?? null;
    if (got !== null && got + 1 < height) {
      degraded.push(
        `source-max-${got}p (requested ${height}p)` +
          (this.loggedIn ? '' : ' — 匿名请求，1080P 需要登录（社交视窗扫码即可）'),
      );
    }
    if (!videos.length && !progressive) {
      throw new BiliError(
        '这个视频没有可用的视频流（可能是付费/会员专享，或已被下架）。',
        'rejected',
      );
    }
    return { qualityIds, qualityLabels, videos, audios, progressive, height: got, requestedHeight: height, degraded };
  }

  /** 字幕。优先中文；没有就说没有，不退化成猜测。 */
  async subtitles(meta: BiliMeta, signal?: AbortSignal): Promise<SubtitleInfo> {
    let d: any;
    try {
      d = await this.wbiApi('/x/player/wbi/v2', { aid: meta.aid, cid: meta.cid }, signal);
    } catch {
      // wbi 接口拿不到就退回旧接口：两个都挂才算没有。
      try {
        d = await this.api('/x/player/v2', { aid: meta.aid, cid: meta.cid }, signal);
      } catch {
        return { available: false, reason: '字幕接口未响应（可能被风控或需要登录）。', segments: [] };
      }
    }
    const tracks: any[] = d?.subtitle?.subtitles ?? [];
    if (!tracks.length) {
      return {
        available: false,
        reason: this.loggedIn ? '这个视频没有字幕轨。' : '未登录时看不到字幕轨；社交视窗扫码后重试。',
        segments: [],
      };
    }
    const selected = tracks.find((s) => /^zh/i.test(String(s.lan))) ?? tracks[0];
    const raw = await this.fetchSubtitleJson(String(selected.subtitle_url ?? ''), signal);
    const body: any[] = Array.isArray(raw?.body) ? raw.body : [];
    const segments: TranscriptSegment[] = body
      .map((s) => ({
        from: Number(s.from),
        to: Number(s.to),
        text: stripSubtitleMarkup(s.content),
      }))
      .filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to) && s.text);
    if (!segments.length) {
      return { available: false, reason: '字幕文件是空的。', segments: [] };
    }
    return {
      available: true,
      lang: String(selected.lan ?? ''),
      langDoc: String(selected.lan_doc ?? ''),
      segments,
      raw,
    };
  }

  private async fetchSubtitleJson(url: string, signal?: AbortSignal): Promise<any> {
    if (!url) return null;
    const abs = url.startsWith('//') ? `https:${url}` : url;
    const u = new URL(abs);
    if (u.protocol !== 'https:' || !/\.(hdslb\.com|bilivideo\.com|bilivideo\.cn)$/.test(u.hostname)) {
      throw new BiliError('字幕地址不属于 B站媒体域名，已拒绝。', 'invalid');
    }
    return this.raw(u.href, {}, signal, false);
  }

  /**
   * 把选中的轨道落盘成一份 mp4（视频+音频 `-c copy` 合流）。
   *
   * **视频轨必须沿用在 playurl() 里挑过的那一档，不能在这里重新 pickBest()。**
   * 接口一次返回 12 条 DASH 轨（360p 到 1080P+），重新挑会拿到最高的那条：
   * 实测一条 33 秒视频，扫描只要 480p，却下了 1080P 的 4.2Mbps 轨，
   * **首次下载从 ~9 秒涨到 194 秒**，而画面像素一个都没多（扫描本来就会缩到 480p）。
   * 所以：`info.height` 说了算。
   *
   * 返回是否真的带了音轨，供上层在"没有声音"时区分原因。
   */
  async download(
    info: PlayInfo,
    out: string,
    ffmpeg: string,
    opts: { signal?: AbortSignal; timeoutMs?: number; durationSec?: number } = {},
  ): Promise<{ hasAudio: boolean }> {
    // info.height 是 playurl 已经按请求档位过滤后的结果；null 表示源站连最低档都没给。
    const videosAt = info.height === null
      ? info.videos
      : info.videos.filter((t) => (t.height ?? 0) <= info.height! + 1);
    const video = pickBest(videosAt.length ? videosAt : info.videos) ?? null;
    const audio = pickBest(info.audios) ?? null;

    /**
     * **超时按片长算，不要一个固定的 20 分钟。**
     *
     * 原来写死 20 分钟。实测一条 3 分钟、20MB 的 480p 视频因为 CDN 直链
     * 打开失败，**真的耗了 746 秒**才失败 —— 期间模型和用户都在干等，
     * 而这条片正常下载只要 10 秒。
     *
     * 现在按片长给：`片长 × 3 + 60 秒`，下限 90 秒、上限 10 分钟。
     * 3 分钟的片子 → 249 秒仍在合理范围，但比 20 分钟快了 4 倍失败；
     * 一条 2 小时的电影 → 10 分钟封顶（再长就是真出问题了）。
     */
    const dur = Number(opts.durationSec) || 0;
    const timeoutMs = opts.timeoutMs ?? (dur > 0
      ? Math.min(10 * 60_000, Math.max(90_000, dur * 3000 + 60_000))
      : 5 * 60_000);

    const args = ['-hide_banner', '-v', 'error', '-y'];

    if (!video && info.progressive) {
      args.push('-user_agent', USER_AGENT, '-referer', REFERER, '-i', info.progressive);
      args.push('-c', 'copy', '-movflags', '+faststart', out);
      await runFfmpeg(ffmpeg, args, { ...opts, label: 'B站视频流下载' });
      return { hasAudio: true };
    }

    args.push('-user_agent', USER_AGENT, '-referer', REFERER, '-i', (video as DashTrack).url);
    if (audio) {
      args.push('-user_agent', USER_AGENT, '-referer', REFERER, '-i', audio.url);
      // 显式 map：不加的话封面图（mjpeg）会混进来
      args.push('-map', '0:v:0', '-map', '1:a:0');
    } else {
      args.push('-map', '0:v:0');
    }
    args.push('-c', 'copy', '-movflags', '+faststart', out);
    await runFfmpeg(ffmpeg, args, { ...opts, label: 'B站视频流下载' });
    return { hasAudio: Boolean(audio) };
  }

  /** 给 zoom 用：一份新鲜的 1080P 直链（带签名，约 2 小时过期，所以每次重取）。 */
  async frameSource(meta: BiliMeta, height: number, signal?: AbortSignal): Promise<{ uri: string; userAgent: string; referer: string; height: number } | null> {
    try {
      const info = await this.playurl(meta, height, signal);
      const best = pickBest(info.videos);
      if (!best) return null;
      return { uri: best.url, userAgent: USER_AGENT, referer: REFERER, height: best.height ?? height };
    } catch {
      // 直链拿不到不该让 zoom 失败：引擎会自动回落到本地那份低清。
      return null;
    }
  }
}

function mapTrack(t: any): DashTrack {
  const base = String(t.baseUrl ?? t.base_url ?? '');
  const backups = (t.backupUrl ?? t.backup_url ?? []).map(String).filter(Boolean);
  return {
    url: base,
    backupUrls: backups,
    width: Number(t.width) || undefined,
    height: Number(t.height) || undefined,
    bandwidth: Number(t.bandwidth) || undefined,
    codecs: t.codecs ? String(t.codecs) : undefined,
    codecid: Number(t.codecid) || undefined,
    id: Number(t.id) || undefined,
    mimeType: t.mimeType ? String(t.mimeType) : undefined,
  };
}

/**
 * 挑一条轨道：**先看高度，再优先 AVC**。
 * 优先 AVC 是因为 hevc/av1 在某些老 ffmpeg 构建上要看解码器脸色，
 * 而"能出图"比"省 20% 码率"重要得多。
 */
function pickBest(tracks: DashTrack[]): DashTrack | null {
  const ok = tracks.filter((t) => t.url);
  if (!ok.length) return null;
  const rank = (t: DashTrack) => [
    t.height ?? 0,
    t.codecid === 7 ? 1 : 0,
    t.bandwidth ?? 0,
  ];
  return ok.slice().sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return rb[0] - ra[0] || rb[1] - ra[1] || rb[2] - ra[2];
  })[0];
}

export function stripSubtitleMarkup(text: unknown): string {
  return String(text ?? '')
    .replace(/<[^>]{1,80}>/g, '')
    .replace(/\{\\[^}]{1,40}\}/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** 跑一次 ffmpeg，把 stderr 收进错误信息（原因永远在那里）。 */
export function runFfmpeg(
  bin: string,
  args: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const label = opts.label ?? 'ffmpeg';
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false });
    } catch (error) {
      reject(new BiliError(`无法启动 ${bin}：${(error as Error).message}`, 'network'));
      return;
    }
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      finish(() => {
        child.kill();
        reject(new BiliError('操作已取消。', 'network'));
      });
    };
    const timer = setTimeout(() => {
      finish(() => {
        child.kill();
        reject(new BiliError(`${label}超时（${Math.round(timeoutMs / 60000)} 分钟）。`, 'network'));
      });
    }, timeoutMs);
    timer.unref?.();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-4096);
    });
    child.on('error', (error) => {
      const msg = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `找不到 ${bin}。装好 ffmpeg 并加进 PATH，或在配置里填绝对路径。`
        : `${label}启动失败：${error.message}`;
      finish(() => reject(new BiliError(msg, 'network')));
    });
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new BiliError(`${label}失败（${code}）：${explainFfmpegStderr(stderr)}`, 'network'));
      });
    });
  });
}

/**
 * 把 ffmpeg 的 stderr 压成一句**能照着做**的话。
 *
 * ## 为什么不能直接截最后三行
 *
 * 实测踩过：一条 3 分钟的 B站视频下载失败，回执里是
 *
 *   `B站视频流下载失败（1）： | Error opening input file https://xy39x184x182x21xy.mcdn…`
 *
 * 400 字的额度**全被那条带签名的 CDN URL 吃掉了**，真正的原因（HTTP 状态、
 * 是否超时、磁盘满）一个字都没留下。模型的反应只能是"再试一次"——
 * 而那条 URL 的签名已经过期，再试必然还是失败。
 *
 * 所以这里：
 *   1. **先丢掉 URL**：`https://…` 换成 `<url>`（签名是可回收垃圾，不该进回执）；
 *   2. **优先挑诊断行**：Error/Invalid/No such/Permission/HTTP 4xx、5xx 那些；
 *   3. 再退回最后一行非空内容；
 *   4. 最后才硬截 300 字。
 */
export function explainFfmpegStderr(stderr: string): string {
  const raw = String(stderr ?? '');
  if (!raw.trim()) return '没有输出（可能是网络中断或磁盘空间不足）';

  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    // 签名 URL 不该进回执：它既不是原因，又长到能把原因挤掉
    .map((l) => l.replace(/https?:\/\/\S+/g, '<url>'))
    .filter(Boolean);
  if (lines.length === 0) return '没有输出';

  // 1) 明确的诊断行优先
  const diagnostic = lines.find((l) =>
    /HTTP\s*(error)?\s*[45]\d\d|Error opening|Invalid data|No such file|Permission denied|ENOSPC|Connection|timed? ?out|Server returned|403|404|412|429/i.test(l),
  );
  if (diagnostic) {
    // 带上它后面的那半句（ffmpeg 常把原因写在同一行的后半段）
    return diagnostic.replace(/^\[[^\]]*\]\s*/, '').slice(0, 300);
  }

  // 2) 退回最后一行（最常见的是 "Conversion failed!" 之类）
  return lines[lines.length - 1].replace(/^\[[^\]]*\]\s*/, '').slice(0, 300);
}
