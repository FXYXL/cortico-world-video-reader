# 视频读懂 · cortico-world-video-reader

给 Coopanion 桌宠用的 **World 扩展**：把一段视频压成**能引用的分镜图**，让看不到画面的模型真正"读"一段视频，而不是猜。

分工：**社交视窗管社交，本扩展管看视频。**

> 社区项目，与 DeepSeek、哔哩哔哩官方均无关。

---

## 它解决什么

模型看不到视频。现有的两条路都有硬伤：

| 做法 | 硬伤 |
|---|---|
| 抽几张截帧发给模型 | 帧与帧之间不知道隔了多久；快剪段全漏、空镜白占额度 |
| 只读标题/简介/评论 | 画面全丢，"这个镜头里到底有什么"永远答不了 |

本扩展走第三条：**把 N 帧打进一张图**，每格烧着编号，配上逐格的字幕和一条同轴音频带。
一张图约 390–990 token（视画布），模型拿到的是**可直接引用的坐标**：
"第 7 格 = 01:12.40-01:20.15，这段说的是『……』"。

---

## 三个工具

### `video_probe` — 先问，再决定怎么读

只读元信息：时长、分P、**这个账号实际能拿到的清晰度**、有没有字幕轨。
不下载、不出图、不花图片 token。读一条没读过的视频先调它。

### `video_storyboard` — 出分镜

- **每格一个镜头**：先扫切点，格子大小由那一段的剪辑密度决定 —— 20 秒长镜头给整幅大格，
  机关枪式快剪给 1/8 小格。
- **行打包排布**：一张图装满才开下一张，格号跨图连续，所以"第 7 格"永远指同一个瞬间。
- **取最锐的一帧**：段内挑 3 个候选比 Laplacian 方差，避开溶解/淡入的叠影。
- **底部音频带与画面同轴**：青色是响度、深灰是静音、黄刻度是切点 —— 零额外 token。
- **文本索引**：每格的绝对时间（0.01 秒精度）＋ 那段时间说的台词，可直接引用。
- **长片分段读**：`from` + `segment`，每次结果的结尾回显 `next: from=…`，照它继续。
  一上来就拉全片总览会把片尾摆在同一屏上（剧透），而且每格更小。

三个真正要调的旋钮：`maxFrames`（看多少瞬间）、`strategy`（每格多大）、`budget`（一张图多少像素）。

### `video_zoom` — 放大重看

对某一格或某一小段时间近距离重看，格子大 4 倍，字幕、人脸、画面里的字都能读。
可以 `cellId: 7` 直接寻址（不用手抄时间码），也可以自己给 `from`/`to`。
**不下载**：按帧回原始流取高清。

---

## 安装

### 前置

| 依赖 | 必需 | 说明 |
|---|---|---|
| **ffmpeg / ffprobe** | 必需 | 出图、扫描、音频带全靠它。装好后加进 PATH，或在配置页填绝对路径。 |
| **B站登录** | 强烈建议 | 不登录只有低清晰度，而且**多数视频看不到字幕**。 |
| 社交视窗 | 可选 | 装了就能直接借用它的登录，不用再扫码。 |

Windows 上装 ffmpeg 最省事的方式：从 [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) 下
`ffmpeg-release-essentials.zip`，解压后把 `...\bin\ffmpeg.exe` 和 `...\bin\ffprobe.exe`
填进「视频读懂 → 配置」。

### 与社交视窗共用登录（推荐）

社交视窗扫码登录后，会把 cookie 写进部署的 `.env`，键名是 `SOCIALMEDIA_BILIBILI_COOKIE`。
本扩展**默认直接读它**，所以装完就能用，不需要第二个账号。

- **只读，绝不写。** 本扩展不会改动社交视窗的任何记录、缓存、账本或凭据。
- 想用独立登录：把配置里的「登录来源」改成自己的环境变量名（例如 `VIDEO_READER_BILIBILI_COOKIE`）。

### 让模型优先用本扩展

社交视窗自带的 `socialmedia_watch` 只能抽 2 帧 360P，和本扩展不是一个量级。
建议把它停掉，避免模型二选一：

```json
"worlds": {
  "socialmedia": { "media": { "maxDailyVisualCalls": 0 } }
}
```

改完不用动社交视窗的代码：它的额度判据是 `已用 >= 上限`，设成 0 后 `watch` 会直接回
"今日视觉观察次数已用完；可继续读文字和评论"。**历史记录一条都不会被改动**，
想还原就把这个值改回 20。

---

## 用法示例

```js
// 1. 先看这是什么
video_probe({ video: "BV1xx411c7mD" })

// 2. 短片：一次读完
video_storyboard({ video: "BV1xx411c7mD" })

// 3. 长片：窗口式顺序读（每段结尾会给 next: from=…）
video_storyboard({ video: "BV1xx411c7mD", from: 0, segment: 300 })
video_storyboard({ video: "BV1xx411c7mD", from: 300, segment: 300 })

// 4. 只想读台词、不想再出图（翻页用，不花图片额度）
video_storyboard({ video: "BV1xx411c7mD", textOnly: true, cellRange: [14, 42] })

// 5. 第 7 格看不清，放大重看
video_zoom({ video: "BV1xx411c7mD", cellId: 7 })
```

本地文件把 `video` 换成绝对路径即可，不联网、不下载。

### 和社交视窗配合

本扩展的输出里带一行 `[依据] …（evidence=video|subtitle）`，把它当作
`socialmedia_prepare` 的判断依据即可 —— 社交视窗那套"没看过就别装看过"的护栏，
正好被喂了真凭据。引用时说清是画面还是字幕。

---

## 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| 启用 | 开 | 关掉后不再注册看视频的工具。 |
| 登录来源（环境变量名） | `SOCIALMEDIA_BILIBILI_COOKIE` | 留空 = 匿名。 |
| 匿名读取不报警 | 关 | 确认过的站点可以勾上。 |
| ffmpeg / ffprobe 程序 | 空（用 PATH） | 可填绝对路径。 |
| 扫描清晰度上限 | 480 | 抽帧用的下载档位。480 足够出分镜。 |
| 放大重看清晰度 | 1080 | 回原始流取帧那一档的清晰度。 |
| 回原始流取高清帧 | **关** | 打开最清楚，但 4 帧约 40 秒；关掉读本地 480p 副本，**亚秒级**，看人脸/构图够用。要读画面上的小字（UI、书名、烧进画面的字幕）时才打开。 |
| 单图像素预算 | 640000 | 上限就是 800×800，再高会被宿主缩回去。 |
| 每格台词字数 | med（120） | low=60 / med=120 / high=400，截断落在句末。 |
| 尺寸策略 | **compact** | 每往下一档，每格小一档、张数少一点。实测 compact 比 standard 在同样张数下多 75% 的格。 |
| 单次最多几张图 | **4** | 一段最多 1536 token。**0 不要随便设**：300 秒的正常剪辑窗口实测能出 17 张 = 6528 token。 |
| 单次最多几帧 | 0（不限） | 填正数会合并最短的段，长镜头不受影响。 |
| 默认分段长度 | 300 秒 | 只传 `from` 时自动推下一段。 |
| 每日出图次数上限 | 60 | **含命中缓存的重看**；自主闲逛时的护栏。 |
| 累计图片交付预算 | 512 MB | 达到后继续给文本索引，不再附图。 |
| 媒体缓存上限 | 300 MB | 下载的片子按最近使用淘汰。 |

配置页还有「数据」页签，显示缓存占用与今日用量，可一键清理（不影响用量账本）。

---

## 边界：它不做什么

- **只读**。不评论、不发布、不改社交视窗的任何记录。
- **只支持 B站和本地文件**。其它站点请先下载到本地，再把绝对路径给它。
- **不做语音识别**（V1）。没有字幕轨的视频只能看画面 —— 这一点会写在结果里，
  不会让模型以为听过音频。画面里的硬字幕会出现在格子里。
- **不做硬字幕裁带长图**，不做 OCR 纠错。
- **不保证每个镜头都被看到**：它保证的是**时间轴不漏**。要细节就用 `video_zoom`。
- **不提供付费内容访问、不绕过 DRM、不做地区限制规避、不批量抓取**。
  一次调用只处理一条链接；平台限流（412/429/567）时报错并停止。

落盘的视频副本只在本机，有容量上限并按最近使用淘汰，随时可在配置页清掉。

---

## 开发

```bash
# 端到端冒烟：合成素材 → 出分镜（不联网、不需要 cookie）
node test/smoke.test.mjs

# World 集成：真实工具 handler + 预算账本 + blobs 交付（不联网）
node "<Coopanion>/resources/app/node_modules/tsx/dist/cli.mjs" test/world.local.ts

# B站链路（不联网部分永远跑；LIVE=1 才真的打接口）
node "<Coopanion>/resources/app/node_modules/tsx/dist/cli.mjs" test/bridge.smoke.ts
LIVE=1 BILI_COOKIE="SESSDATA=…; bili_jct=…" node … test/bridge.smoke.ts

# 自描述核对（改完工具/提示词必须跑）
node "<Coopanion>/resources/app/node_modules/tsx/dist/cli.mjs" scripts/export-describe.mjs
node "<Coopanion>/resources/app/node_modules/tsx/dist/cli.mjs" test/check-describe.mjs

# 用桌宠自己的框架模块再核对一遍（可选，需要本机装了 Coopanion）
node "<Coopanion>/resources/app/node_modules/tsx/dist/cli.mjs" test/check-real-framework.mjs
```

**改了 `src/tools.ts` 或 `src/ENV_PROMPT.md` 之后，一定要重新导出 `describe.json`** ——
市场的扩展页只读这个文件，不执行代码。

### 引擎来源

`src/engine/storyboard/` 下的 42 个模块移植自
[dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard)（Apache-2.0），
切点扫描、密度分档、行打包、锐度选帧、拼图与音频带、清单渲染都是它的。
本包换掉了注册层（DSH 的 `index.js` 与 `shared.js` 没有移植），并把数据目录、ffmpeg 路径
改成由 Coopanion 配置驱动。详见 [NOTICE](./NOTICE)。

---

## 许可

Apache-2.0。见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。
