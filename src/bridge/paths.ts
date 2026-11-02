/**
 * bridge/paths.ts — 本 World 自己的目录布局。
 *
 * ## 为什么必须给每个 World 一个私有目录
 *
 * `WorldContext.dataDir` 是**整份部署共享**的（`.../companion/data`），不是每个 World 一个。
 * 我第一次实现时把它当成私有目录，于是往共享区里写了三样东西：
 *
 *   1. `media/` —— 那里放的是**宿主的图片附件库**（几百个 .jpg/.png）。
 *      我的视频副本（每份几十 MB 的 mp4）和它们混在一起。
 *   2. `cache/` —— 引擎的扫描缓存、`cells.json`、`seen.jsonl` 直接落在共享 cache 根上。
 *      宿主自己的缓存是同名的 `.json`，虽然键不同不至于覆盖，但清理时**分不清是谁的**。
 *   3. `transcripts/` —— 相对好一点（目录名是我独有的），但同样不该占用公共命名。
 *
 * 真实后果是闲逛时真实发生过的：鱼调了 3 次 video_storyboard，
 * 三个 30–60MB 的 mp4 就这样躺进了宿主的附件目录，
 * 而「数据清理」页签报的体积却一直是 0（因为它在数另一个目录）。
 *
 * 所以：**所有落盘都收敛到 `<dataDir>/worlds/video-reader/` 下面**，四个子目的一目了然。
 * 迁移见 `migrateLegacy()` —— 老版本留下的文件搬过来并清掉，不留垃圾。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 本 World 的私有根。**不要直接用 ctx.dataDir**。 */
export function worldRoot(dataDir: string): string {
  return join(dataDir, 'worlds', 'video-reader');
}

export interface WorldDirs {
  root: string;
  /** 下载的视频副本（引擎的媒体 LRU）。 */
  media: string;
  /** 引擎的扫描缓存、cells.json、seen.jsonl。 */
  cache: string;
  /** 站点字幕与本地转写。 */
  transcripts: string;
  /** 用量账本、临时产物（如硬字幕长图）。 */
  state: string;
}

export function worldDirs(dataDir: string): WorldDirs {
  const root = worldRoot(dataDir);
  return {
    root,
    media: join(root, 'media'),
    cache: join(root, 'cache'),
    transcripts: join(root, 'transcripts'),
    state: join(root, 'state'),
  };
}

export function ensureDirs(dataDir: string): WorldDirs {
  const d = worldDirs(dataDir);
  for (const p of [d.root, d.media, d.cache, d.transcripts, d.state]) {
    mkdirSync(p, { recursive: true });
  }
  return d;
}

/**
 * 把老版本落在共享目录里的东西搬进私有目录。
 *
 * 只搬**能确认是我们的**：
 *   - `transcripts/asr-*.json`（前缀是我们独有的）
 *   - `cache/cells.json`、`cache/seen.jsonl`（这两个文件名是引擎专用的）
 *   - 引擎扫描缓存：`cache/*.json`，但内容必须是 `{cuts, stats, threshold…}` 那种形状
 *   - `media/` 下那些 20 位十六进制的**目录**（我们独有的分桶形状），
 *     宿主的附件是平铺的 `.jpg/.png` 文件，不会误伤
 *
 * 搬完就删掉原位（媒体目录整个移走之后，那个空壳也清掉）。
 * 任何一步失败都只跳过那一项 —— 迁移不该让插件起不来。
 *
 * @returns 搬了几项，给日志用。
 */
export function migrateLegacy(dataDir: string): { moved: number; notes: string[] } {
  const d = ensureDirs(dataDir);
  const notes: string[] = [];
  let moved = 0;

  const move = (from: string, to: string, label: string) => {
    try {
      if (!existsSync(from)) return false;
      if (existsSync(to)) return false; // 已经有新的了，不覆盖
      mkdirSync(join(to, '..'), { recursive: true });
      renameSync(from, to);
      moved += 1;
      notes.push(`moved ${label}`);
      return true;
    } catch (error) {
      notes.push(`skip ${label}: ${(error as Error).message.slice(0, 60)}`);
      return false;
    }
  };

  // 1) 媒体：只搬 20 位十六进制的目录（我们的分桶），不碰平铺的图片
  const legacyMedia = join(dataDir, 'media');
  if (existsSync(legacyMedia)) {
    let names: string[] = [];
    try {
      names = readdirSync(legacyMedia);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!/^[a-f0-9]{20}$/.test(name)) continue;
      const from = join(legacyMedia, name);
      try {
        if (!statSync(from).isDirectory()) continue;
      } catch {
        continue;
      }
      move(from, join(d.media, name), `media/${name}`);
    }
  }

  // 2) 缓存：cells.json / seen.jsonl 是引擎专用文件名，直接搬
  const legacyCache = join(dataDir, 'cache');
  for (const name of ['cells.json', 'seen.jsonl']) {
    move(join(legacyCache, name), join(d.cache, name), `cache/${name}`);
  }

  // 3) 引擎扫描缓存：形状必须像 {cuts|prints|stats|printPack|threshold}
  if (existsSync(legacyCache)) {
    let names: string[] = [];
    try {
      names = readdirSync(legacyCache).filter((n) => n.endsWith('.json'));
    } catch {
      names = [];
    }
    for (const name of names) {
      if (name === 'cells.json') continue;
      const from = join(legacyCache, name);
      let looksOurs = false;
      try {
        const raw = JSON.parse(readFileSync(from, 'utf8'));
        looksOurs = Boolean(raw && (raw.cuts || raw.printPack || raw.stats || raw.threshold !== undefined));
      } catch {
        looksOurs = false;
      }
      if (looksOurs) move(from, join(d.cache, name), `cache/${name}`);
    }
  }

  // 4) 字幕：`asr-` 前缀是我们独有的
  const legacyTranscripts = join(dataDir, 'transcripts');
  if (existsSync(legacyTranscripts)) {
    let names: string[] = [];
    try {
      names = readdirSync(legacyTranscripts);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.startsWith('asr-')) continue;
      move(join(legacyTranscripts, name), join(d.transcripts, name), `transcripts/${name}`);
    }
    // 搬空了就把这个目录删掉（它本来只该有我们的东西）
    try {
      if (readdirSync(legacyTranscripts).length === 0) rmSync(legacyTranscripts, { recursive: true, force: true });
    } catch {
      /* 还有别人的东西，留着 */
    }
  }

  return { moved, notes };
}

/** 目录体积（有上限地走）。面板显示用。 */
export function dirSize(dir: string, budget = 4000): number {
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

/** 目录里有多少个文件（不递归）。 */
export function fileCount(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).length;
  } catch {
    return 0;
  }
}
