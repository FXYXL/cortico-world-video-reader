/**
 * config.ts — 本 World 的配置段与默认值。
 *
 * 设计约束：**默认值必须能在"什么都没配"的机器上跑出结果**。
 * 所以默认读社交视窗已经存好的 B站 cookie、默认用 PATH 上的 ffmpeg、
 * 默认把清晰度压在 480P（扫描只需要这么多像素），默认保留一份 300MB 的媒体缓存。
 */
import type { ConfigGroup } from 'cortico/core/types.ts';
import type { WorldSection } from 'cortico/world.ts';

export const VIDEO_READER_ID = 'video-reader';

/**
 * 默认读社交视窗的登录。
 *
 * 这不是"偷偷用别人的密钥"：社交视窗扫码后把它写进部署 .env，
 * 本 World 只读、绝不写。理由是**同一台机器上同一个账号**没必要登录两次；
 * 哪天想分开，把这里改成自己的名字（例如 VIDEO_READER_BILIBILI_COOKIE）即可。
 */
export const DEFAULT_COOKIE_SECRET = 'SOCIALMEDIA_BILIBILI_COOKIE';

export interface VideoReaderConfigSection extends WorldSection {
  /** 扫描用的清晰度上限。分镜只需要这么多像素；调高只会让下载变慢。 */
  scanHeight: number;
  /** 放大重看时的清晰度上限（不落盘，按帧读原始流）。 */
  zoomHeight: number;
  /**
   * 放大重看时是否回原始流取帧。
   *
   * `true`：按帧读 zoomHeight 那一档，最清楚，但**每次 seek 都要走 HTTP** ——
   * 实测一条 33 秒视频的 1080P 取 4 帧要 40 秒左右。
   * `false`（默认）：直接读本地那份扫描副本（480p）。**快两个数量级**（亚秒级），
   * 而扫描副本宽 854（480p），对 4 格（每格 400×227）仍有 2 倍超采样 —— 看人脸、看构图够用。
   * 什么时候该开：要读画面上的小字（UI、书名、烧进画面的字幕）时。
   */
  zoomFromStream: boolean;
  /** 单张分镜图的像素预算，上限 640000 = 800x800（宿主视觉上限）。 */
  budget: number;
  /** 单次最多返回几张图。0 = 不限（排布器说了算）。 */
  maxSheets: number;
  /** 单次最多取多少帧。0 = 不限（切点说了算）。 */
  maxFrames: number;
  /** 每格给多少字的台词：low=60 / med=120 / high=400。 */
  detail: string;
  /** 尺寸策略：full / standard / compact / skim / brief。 */
  strategy: string;
  /** 只传 from 时的默认窗口长度（秒）。 */
  segment: number;
  /** 媒体缓存容量上限（MB）。下载的片子按 LRU 淘汰。 */
  mediaMaxMB: number;
  /** 每日最多跑几次出图（含缓存命中）。防止自主闲逛时无上限地花图片 token。 */
  maxDailyCalls: number;
  /** 累计交付给宿主的图片预算（MB）。达到后只返回文本索引。 */
  maxDeliveredMB: number;
  /** ffmpeg 可执行文件；留空用 PATH 上的 ffmpeg。 */
  ffmpegFile: string;
  /** ffprobe 可执行文件；留空用 PATH 上的 ffprobe。 */
  ffprobeFile: string;
  /** 读哪个环境变量里的 B站 cookie。留空 = 不读（匿名）。 */
  cookieSecret: string;
  /** 匿名也能读的站点允许直接跑，不额外警告。 */
  allowAnonymous: boolean;

  /**
   * 没有字幕轨时用什么转写台词。
   * - auto（默认）：本机有桌宠自带语音模型就用本地识别，没有就明说没有台词
   * - sherpa：强制用本地模型
   * - api：走 OpenAI 兼容的 /audio/transcriptions
   * - off：不转写，只出画面
   */
  asrMode: string;
  /** auto/sherpa 模式下：指定模型目录（留空自动找 models/desktop-pet/）。 */
  asrModelDir: string;
  /** sherpa-onnx-node 的解析路径（留空按包名）。 */
  asrSherpaPath: string;
  /** sensevoice 的识别语言：zh/en/ja/ko/yue/auto。 */
  asrLanguage: string;
  /** api 模式：OpenAI 兼容端点，如 http://127.0.0.1:8000/v1。 */
  asrApiUrl: string;
  /** api 模式：Bearer 令牌（本机服务通常不需要）。 */
  asrApiKey: string;
  /** api 模式：模型名。 */
  asrApiModel: string;
}

export const VIDEO_READER_DEFAULTS: VideoReaderConfigSection = {
  // 装上就是要用；不想用了在配置页关掉。
  enabled: true,
  scanHeight: 480,
  zoomHeight: 1080,
  // 实测：回原始流取 4 帧要 40 秒，而本地 480p 副本对 4 格仍有 2 倍超采样。
  // 所以默认快，要读画面小字时在配置页打开。
  zoomFromStream: false,
  budget: 640_000,
  maxSheets: 4,
  maxFrames: 0,
  detail: 'med',
  strategy: 'compact',
  segment: 300,
  mediaMaxMB: 300,
  maxDailyCalls: 60,
  maxDeliveredMB: 512,
  ffmpegFile: '',
  ffprobeFile: '',
  cookieSecret: DEFAULT_COOKIE_SECRET,
  allowAnonymous: false,
  // **默认 auto**：本机有桌宠自带语音模型就直接用（用户零配置），
  // 没有就明说没有台词——比默默只出画面好。
  asrMode: 'auto',
  asrModelDir: '',
  asrSherpaPath: '',
  asrLanguage: 'auto',
  asrApiUrl: '',
  asrApiKey: '',
  asrApiModel: 'whisper-1',
};

/** Core 自动渲染的配置表单。不写自定义面板，省掉前端构建产物。 */
export const VIDEO_READER_CONFIG_GROUP: ConfigGroup = {
  id: 'world:video-reader',
  owner: 'world:video-reader',
  schema: {
    type: 'object',
    title: '视频读懂',
    properties: {
      'worlds.video-reader.enabled': {
        type: 'boolean',
        title: '启用',
        description: '关掉后本 World 不再注册看视频的工具。',
        'x-hot': true,
      },
      'worlds.video-reader.cookieSecret': {
        type: 'string',
        title: '登录来源（环境变量名）',
        description:
          '默认 SOCIALMEDIA_BILIBILI_COOKIE —— 直接复用社交视窗扫码存下的登录，只读不写。' +
          '留空则匿名读取（只有低清晰度，且多半没有字幕）。',
        'x-hot': true,
      },
      'worlds.video-reader.allowAnonymous': {
        type: 'boolean',
        title: '匿名读取不报警',
        description: '确认过的站点可以勾上，省掉结果里的降级提示。',
        'x-hot': true,
      },
      'worlds.video-reader.ffmpegFile': {
        type: 'string',
        title: 'ffmpeg 程序',
        description: '留空用 PATH 上的 ffmpeg。填绝对路径可指向桌面版自带的副本。',
        'x-hot': true,
      },
      'worlds.video-reader.ffprobeFile': {
        type: 'string',
        title: 'ffprobe 程序',
        description: '留空用 PATH 上的 ffprobe。',
        'x-hot': true,
      },
      'worlds.video-reader.scanHeight': {
        type: 'integer',
        title: '扫描清晰度上限',
        minimum: 120,
        maximum: 2160,
        description: '抽帧用的下载档位。480 足够出分镜；调高只会让下载变慢。',
        'x-hot': true,
      },
      'worlds.video-reader.zoomHeight': {
        type: 'integer',
        title: '放大重看清晰度',
        minimum: 120,
        maximum: 2160,
        description: 'video_zoom 回原始流取帧用的档位，不落盘。1080 起步。',
        'x-hot': true,
      },
      'worlds.video-reader.zoomFromStream': {
        type: 'boolean',
        title: '放大重看时回原始流取高清帧',
        description:
          '打开后 video_zoom 按帧读原始流（最清楚），但每次 seek 都走 HTTP —— 33 秒视频取 4 帧约 40 秒。' +
          '关掉则直接读本地扫描副本（480p），亚秒级完成，看人脸/构图够用。要读画面上的小字时再打开。',
        'x-hot': true,
      },
      'worlds.video-reader.budget': {
        type: 'integer',
        title: '单图像素预算',
        minimum: 64000,
        maximum: 640000,
        description: '上限 640000 = 800x800，超过会被宿主的视觉上限缩回去，清单里的格子尺寸就不准了。',
        'x-hot': true,
      },
      'worlds.video-reader.detail': {
        type: 'string',
        title: '每格台词字数',
        enum: ['low', 'med', 'high'],
        description: 'low=60 / med=120 / high=400。截断落在句末。',
        'x-hot': true,
      },
      'worlds.video-reader.strategy': {
        type: 'string',
        title: '尺寸策略',
        enum: ['full', 'standard', 'compact', 'skim', 'brief'],
        description:
          'compact 默认（实测：同一窗口内它比 standard 多出 75% 的格，张数不变）。' +
          '每往下一档，每格小一档、张数少一点：full 最大、brief 最省（只够看出换了镜头）。',
        'x-hot': true,
      },
      'worlds.video-reader.maxSheets': {
        type: 'integer',
        title: '单次最多几张图',
        minimum: 0,
        maximum: 64,
        description:
          '4（默认）= 一段最长 1536 token。**0 非常危险**：300 秒的正常剪辑窗口实测能出 17 张 = 6528 token，' +
          '6 倍价钱换来的信息量打不过 4 张。只有"先确认这是什么片"时才临时调到 0。',
        'x-hot': true,
      },
      'worlds.video-reader.maxFrames': {
        type: 'integer',
        title: '单次最多几帧',
        minimum: 0,
        maximum: 10000,
        description: '0 = 不限（切点说了算）。填正数会合并最短的段，长镜头不受影响。',
        'x-hot': true,
      },
      'worlds.video-reader.segment': {
        type: 'integer',
        title: '默认分段长度（秒）',
        minimum: 30,
        maximum: 3600,
        description: '只传 from 时自动推下一段。长片默认 300 秒一段顺序读。',
        'x-hot': true,
      },
      'worlds.video-reader.maxDailyCalls': {
        type: 'integer',
        title: '每日出图次数上限',
        minimum: 0,
        maximum: 500,
        description: '含命中缓存的重看。自主闲逛时的护栏，防止无上限地花图片 token。',
        'x-hot': true,
      },
      'worlds.video-reader.maxDeliveredMB': {
        type: 'integer',
        title: '累计图片交付预算（MB）',
        minimum: 8,
        maximum: 16384,
        description: '达到后继续返回文本索引，不再附图。清理缓存不重置此计数。',
        'x-hot': true,
      },
      'worlds.video-reader.asrMode': {
        type: 'string',
        title: '语音识别（没有字幕轨时）',
        enum: ['auto', 'sherpa', 'api', 'off'],
        description:
          'auto 默认：本机有桌宠自带语音模型（models/desktop-pet/）就直接用，没有就明说没有台词，' +
          '不会假装听过音频。sherpa 强制用本地模型；api 走下面的 OpenAI 兼容端点；off 只出画面。',
        'x-hot': true,
      },
      'worlds.video-reader.asrModelDir': {
        type: 'string',
        title: '本地语音模型目录',
        description: '留空自动找桌宠自带的那套（models/desktop-pet/ 下有 model.int8.onnx + tokens.txt）。',
        'x-hot': true,
      },
      'worlds.video-reader.asrLanguage': {
        type: 'string',
        title: '识别语言',
        enum: ['auto', 'zh', 'en', 'ja', 'ko', 'yue'],
        description: '只对 SenseVoice 生效；Paraformer 只认中文，会忽略这一项。',
        'x-hot': true,
      },
      'worlds.video-reader.asrApiUrl': {
        type: 'string',
        title: '语音 API 端点',
        description: 'api 模式用，形如 http://127.0.0.1:8000/v1（会自动拼 /audio/transcriptions）。',
        'x-hot': true,
      },
      'worlds.video-reader.asrApiKey': {
        type: 'string',
        title: '语音 API 令牌',
        description: '本机服务通常不需要。不要填云端密钥后把配置文件分享出去。',
        'x-hot': true,
      },
      'worlds.video-reader.asrApiModel': {
        type: 'string',
        title: '语音 API 模型名',
        description: '默认 whisper-1；本地服务可能要求别的名字。',
        'x-hot': true,
      },
      'worlds.video-reader.asrSherpaPath': {
        type: 'string',
        title: 'sherpa-onnx-node 路径',
        description: '留空按包名解析；只有装在奇怪位置时才需要填。',
        'x-hot': true,
      },
      'worlds.video-reader.mediaMaxMB': {
        type: 'integer',
        title: '媒体缓存上限（MB）',
        minimum: 32,
        maximum: 8192,
        description: '下载的片子按最近使用淘汰；同一支片子第二次读直接命中。',
        'x-hot': true,
      },
    },
  },
};
