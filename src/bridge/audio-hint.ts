/**
 * bridge/audio-hint.ts — 「这像不像音乐片」。
 *
 * ## 为什么 probe 要回答这件事
 *
 * 实测过三次真实的自主闲逛调用（鱼自己发起的）：**两次是纯音乐**。
 * 那两次它都花了 30–40 秒：下载副本 → 扫描切点 → 跑语音识别 →
 * 识别器吐出 4 条「。」→ 幻觉过滤全丢 → 结果只能说"没听到人话"。
 *
 * 而这三次里有两次其实**在 probe 阶段就能判断**出来 —— 只要听过一遍音频的包络。
 * 30 秒里最贵的一段（语音识别）本可以省掉。
 *
 * ## 判据从哪来（不是拍脑袋）
 *
 * `engine/storyboard/audio.js` 的 `rhythmProfile()`：语音的能量包络有**音节级调制峰**
 * （实测主导频率 1–2 Hz），音乐被节拍和段落结构主导（3–4 Hz）。
 *
 * 区别不在响度，在**包络怎么起伏** —— 所以把整段音量调大调小，判据不变。
 * 这正是"mean LUFS > -18"那种判据缺的性质：那个量的是母带电平，不是内容。
 *
 * 10 支实测素材区分得很干净（见引擎的 test/audio-rhythm.test.mjs）：
 *   - 口播/讲座/实况/vlog：peakHz 1–2，rhythmRatio 不高
 *   - 纯音乐 PV：peakHz 3–4，rhythmRatio 明显偏高
 *
 * ## 这里的定位
 *
 * 只做**建议**，不替模型决定。判成"像音乐"时，probe 会说一句
 * "别指望台词，voice 可能白花时间"，但还是把工具交给它 ——
 * 有些音乐视频确实有旁白，硬拦会错。
 */

import { analyzeRhythm } from '../engine/storyboard/audio.js';

export type AudioKind = 'speech' | 'music' | 'mixed' | 'unknown';

export interface AudioHint {
  kind: AudioKind;
  /** 主导调制频率（Hz）。语音 1–2，音乐 3–4。 */
  peakHz: number;
  /** 3–6Hz 能量 ÷ 0.5–2Hz 能量。音乐片明显偏高。 */
  rhythmRatio: number;
  /** 给人看的一句话。 */
  text: string;
  /** 分析花了多久（秒）。 */
  seconds: number;
}

/**
 * 听一遍音频，给一个"这是说话还是音乐"的判断。
 *
 * **永远不抛错**：这段分析对"能不能读"毫无影响，只影响"该不该指望台词"。
 * 分析不出来就返回 `unknown`，正文里那一行干脆不出现。
 */
export async function audioHint(o: {
  input: string;
  ffmpegPath: string;
  from?: number;
  to?: number;
}): Promise<AudioHint | null> {
  const t0 = Date.now();
  try {
    const r = await analyzeRhythm({
      input: o.input,
      ffmpegPath: o.ffmpegPath,
      start: o.from ?? 0,
      ...(Number.isFinite(o.to) ? { end: o.to } : {}),
    });
    const seconds = (Date.now() - t0) / 1000;
    if (!r || !Number.isFinite(r.peakHz) || !(r.windows > 0)) return null;

    const peak = r.peakHz;
    const ratio = r.rhythmRatio;

    /**
     * 阈值**不是**照文献抄的 3–4 Hz，而是照实测。
     *
     * 文献（Scheirer & Slaney）说音乐节拍主导 3–4 Hz，引擎的合成信号测试也用 4 Hz 造样本。
     * 但**真实素材不落在那里**：实测 `world.execute (me)` 这支纯音乐 PV（节拍型 BGM、
     * 整片没有一句人声）算出来是 **peakHz 2.0 / ratio 1.2** ——
     * 照 3–4 Hz 设阈值，它会被判成"像人声"，模型于是白跑一趟语音识别。
     *
     * 引擎测试文件自己的注释也承认这件事：
     *   「2 Hz 的强调制是"慢速节拍"，不该被算成短语型」
     *
     * 所以分界取 **2.0**。判错的方向也选了：**宁可说"像音乐"** ——
     * 说错了只是模型少等一次识别，说反了要白花 30–40 秒。
     */
    /**
     * **两个量必须一起看**，单看任何一个都会错。
     *
     * 实测数据（4 条真实 B站素材 + 1 段 SAPI 纯人声）：
     *
     *   素材                        peakHz  ratio  真身
     *   8f9e（赛博朋克，有口播）       1.0    0.69   说话
     *   SAPI 纯人声                   2.0    0.88   说话
     *   b736（大肥鱼，有歌词）          2.0    1.34   音乐
     *   fc61（world.execute me）     2.0    1.20   音乐
     *   b30f（大肥鱼 Live2D）          3.0    1.87   音乐
     *
     * 关键：**peakHz=2.0 这一档说话和音乐都有**（SAPI 0.88 vs 音乐 1.2–1.34）。
     * 只按 peakHz ≥ 2 判，SAPI 人声会被误判成音乐。
     * 但 ratio 把它们分开了：说话 ≤0.9，音乐 ≥1.2。
     *
     * 所以规则是「**ratio 是主判据，peakHz 只用来兜底**」：
     *   ratio ≥ 1.15          → 音乐（节拍性明确）
     *   ratio < 1.15 && peak ≥ 2.6 → 音乐（几乎没有慢起伏的强节拍型，兜底）
     *   其余                   → 说话 / 说不准
     *
     * 判错方向仍然是宁可说像音乐，但那句话里已经写明了就算有字幕轨也多半是歌词，
     * 模型可以自己判断要不要试一次。
     */
    const musicLike = ratio >= 1.15 || (peak >= 2.6 && ratio >= 1.0);
    const speechLike = ratio < 1.0;
    const kind: AudioKind = musicLike && !speechLike ? 'music' : speechLike ? 'speech' : 'mixed';

    const text =
      kind === 'music'
        ? `听起来像配乐（包络主导 ${peak.toFixed(1)}Hz，节拍比 ${ratio.toFixed(1)}）：` +
          '这条大概没有可读的旁白。**别指望台词** —— 就算有字幕轨也多半是歌词；' +
          '语音识别跑完很可能什么都听不到。想看清画面就直接 storyboard，不必等词。'
        : kind === 'speech'
          ? `听起来像人声（包络主导 ${peak.toFixed(1)}Hz）：这条应该有可读的台词。`
          : `音频特征不明显（包络主导 ${peak.toFixed(1)}Hz，节拍比 ${ratio.toFixed(1)}）：` +
            '可能有旁白也可能只是配乐，读一次就知道。';

    return { kind, peakHz: peak, rhythmRatio: ratio, text, seconds };
  } catch {
    // 分析失败（没有音轨、ffmpeg 的问题）不该影响 probe
    return null;
  }
}
