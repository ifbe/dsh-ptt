// tts.js — 文字合成语音。PTT_TTS 选择合成器：
//   say    → macOS 本地 say（-o 生成 wav / 直接播）
//   openai → omlx /v1/audio/speech（OpenAI 兼容，返回 wav）
//   none   → 禁用
// 用途分成两种：拿 wav 缓冲（ws 广播/本地播放），或直接本地播放。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';

/** 清洗待合成文本：换行/特殊标记符号(* # _ ` | ~ ^ \)/emoji → 空格，并合并多余空白。
 *  omlx TTS 遇换行会切音色、遇符号/emoji 会乱读或无法播放，故统一替换成空格。 */
export function cleanTtsText(text) {
  return String(text)
    .replace(/\r?\n+/g, ' ')
    .replace(/[#*`_|~^\\]/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 删除旧的 TTS wav 文件（下次 TTS 前清理，防堆积）。统一名：dsh_ptt_tts*.wav（含 tts.wav/_1/_2 等） */
export function cleanupTtsChunks() {
  try {
    for (const f of fs.readdirSync('/tmp')) {
      if (/^dsh_ptt_tts.*\.wav$/.test(f)) fs.rmSync(`/tmp/${f}`, { force: true });
    }
  } catch { /* 目录读不到就忽略 */ }
}

/** 把一段 wav 缓冲保存为分段块文件（_1/_2/... 1 起），返回路径 */
export function saveTtsWav(buf, idx) {
  const p = `/tmp/dsh_ptt_tts_${idx + 1}.wav`;
  fs.writeFileSync(p, buf);
  return p;
}

/**
 * 按 ≤maxSize 切割文本成块，分割点优先级：换行 > 中英文句号(。.) > 其他符号(，；！？,;!?)；
 * 没有可分割符则硬切；最多 50 块。
 * @returns {string[]} 块数组（每块为原始文本片段，含分割符）
 */
export function splitTtsText(text, maxSize) {
  const s = String(text);
  if (!maxSize || maxSize <= 0 || s.length <= maxSize) return [s];
  const NEWLINE = '\n', PERIOD = '。.', OTHER = '，；！？,;!?';
  const chunks = [];
  let rest = s;
  while (rest.length > maxSize && chunks.length < 50) {
    const win = rest.slice(0, maxSize);
    let split = -1;
    for (let i = win.length - 1; i >= 0; i--) if (win[i] === NEWLINE) { split = i; break; }
    if (split < 0) for (let i = win.length - 1; i >= 0; i--) if (PERIOD.includes(win[i])) { split = i; break; }
    if (split < 0) for (let i = win.length - 1; i >= 0; i--) if (OTHER.includes(win[i])) { split = i; break; }
    if (split < 0) split = win.length - 1; // 无分割符 → 硬切
    chunks.push(rest.slice(0, split + 1));
    rest = rest.slice(split + 1).trim();
  }
  // 剩下一段作为独立一块（≤maxSize 为正常末块；若达 50 块上限溢出则为超长末块）
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * 切块并逐块合成到分片 wav 文件。返回文件路径数组。
 * 仅当 PTT_TTS_MAXSIZE 设了才切块；否则返回一个整段文件（或空）。
 * @param text 待合成文本
 * @param cfg 配置（PTT_TTS_MAXSIZE 决定是否切块）
 * @returns {Promise<string[]>} 分片 wav 路径
 */
export async function synthesizeSplit(text, cfg, out) {
  const maxSize = Number(cfg.PTT_TTS_MAXSIZE || 0);
  if (!maxSize) {
    // 未设 → 原流程：整段合成，返回单个文件路径（统一名 tts.wav；若无 wav 则返回空）
    const r = await ttsWav(text, cfg, out);
    if (!r.wav) return [];
    const p = '/tmp/dsh_ptt_tts.wav';
    fs.writeFileSync(p, r.wav);
    return [p];
  }
  cleanupTtsChunks(); // 下次 TTS 前清理旧分片
  const chunks = splitTtsText(text, maxSize);
  const paths = [];
  for (let i = 0; i < chunks.length; i++) {
    const content = cleanTtsText(chunks[i]);
    const shown = content.length > 50 ? `${content.slice(0, 50)}…` : content;
    out?.log?.(`[ptt] 🎤 tts分段=${i + 1}/${chunks.length}，字数=${content.length}，内容=${shown}`);
    const r = await ttsWav(chunks[i], cfg, out, true); // quiet：跳过「合成中」，只留分段+收到
    if (r.error) { out?.error?.(`[ptt] ❌ 该段合成失败: ${r.error}`); continue; }
    paths.push(saveTtsWav(r.wav, i));
  }
  return paths;
}

/** macOS say -o 生成 wav 文件 */
async function sayWav(text, cfg, out, quiet) {
  const clean = cleanTtsText(text); // 换行/特殊标记符号/emoji → 空格，防乱读
  if (!quiet) out?.log?.(`[ptt] 🎤 TTS 合成中...（${clean.length} 字）`);
  const wavPath = `/tmp/dsh_ptt_tts.wav`; // 统一名：非分段用 tts.wav，每次覆盖
  await new Promise((resolve, reject) => {
    const p = spawn('say', ['-v', cfg.VOICE_NAME, '-o', wavPath, '--data-format=LEI16@16000', clean]);
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`say 退出码 ${code}`))));
  });
  const buf = fs.readFileSync(wavPath);
  out?.log?.(`[ptt] 📦 tts收到=${buf.length} 字节`);
  return buf;
}

/** openai：调 omlx /v1/audio/speech → wav 缓冲 */
async function openaiWav(text, cfg, out, quiet) {
  const input = cleanTtsText(text); // 换行/特殊标记符号/emoji → 空格，防乱读/切音色
  if (!quiet) out?.log?.(`[ptt] 🎤 TTS 合成中...（${input.length} 字）`);
  const baseUrl = (cfg.PTT_TTS_URL || cfg.OMLX_BASE_URL || '').replace(/\/$/, '');
  const apiKey = cfg.PTT_TTS_KEY || cfg.OMLX_API_KEY || '';
  const model = cfg.PTT_TTS_MODEL || 'Qwen3-TTS-12Hz-0.6B-Base-4bit';
  const voice = cfg.PTT_TTS_VOICE || 'alloy';
  const body = JSON.stringify({ model, input, voice });
  const res = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  out?.log?.(`[ptt] 📦 tts收到=${buf.length} 字节`);
  return buf;
}

/**
 * 生成语音 wav 缓冲。返回 {wav: Buffer} 或 {error: string}。
 * @param text 要朗读的文本
 * @param cfg 插件配置（PTT_TTS / VOICE_NAME / OMLX_BASE_URL / PTT_TTS_*）
 * @param out 日志输出（可选，带 .log）
 * @param quiet 设为 true 时跳过「合成中」提示（分段场景避免冗余），仍打印「收到」
 */
export async function ttsWav(text, cfg, out, quiet) {
  try {
    if (cfg.PTT_TTS === 'none') return { error: '无有效TTS工具（PTT_TTS=none）' };
    if (cfg.PTT_TTS === 'openai') return { wav: await openaiWav(text, cfg, out, quiet) };
    if (cfg.PTT_TTS === 'say') return { wav: await sayWav(text, cfg, out, quiet) };
    return { error: `未知 PTT_TTS=${cfg.PTT_TTS}` };
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
}

/** 按 OS 分候选，找一个本地音频播放器：macOS→afplay；Linux→aplay/paplay/ffplay */
export function wavPlayer() {
  const candidates = process.platform === 'darwin' ? ['afplay']
    : process.platform === 'linux' ? ['aplay', 'paplay', 'ffplay']
    : ['afplay', 'aplay', 'paplay', 'ffplay'];
  for (const c of candidates) {
    try {
      execFileSync('which', [c], { stdio: 'ignore' });
      return c;
    } catch { /* 没有就试下一个 */ }
  }
  return null;
}

/** 解析本地播放器：优先 PTT_TTS_PLAYER（用户指定），否则按 OS 探测。返回命令名或 null。 */
export function resolvePlayer(cfg) {
  if (cfg.PTT_TTS_PLAYER) return cfg.PTT_TTS_PLAYER;
  return wavPlayer();
}

/** 本地播放一个已存在的 wav 文件。返回 null 成功，或错误字符串。 */
export function playWavFile(wavPath, cfg, out) {
  const player = cfg.LOCAL_PLAYER; // = PTT_OUTPUT_AUDIO 的实际播放器（say/aplay/afplay/ffplay）
  if (!player || player === 'ws' || player === 'none') return '没有可用的本地播放器';
  out?.log?.(`[ptt] 🔊 播放命令: ${player} ${wavPath}`);
  return new Promise((resolve) => {
    const p = spawn(player, [wavPath], { stdio: 'ignore' });
    p.on('error', (e) => resolve(`播放器启动失败（${e?.message ?? e}）`));
    p.on('exit', (code) => resolve(code === 0 ? null : `播放器退出码 ${code}`));
  });
}

/**
 * 本地播放一段 wav 缓冲。返回 null 成功，或错误字符串。
 * @param buf wav 缓冲
 * @param cfg
 */
export function playWavBuffer(buf, cfg, out) {
  const player = cfg.LOCAL_PLAYER;
  if (!player || player === 'ws' || player === 'none') return '没有可用的本地播放器';
  const wavPath = `/tmp/dsh_ptt_tts.wav`; // 统一名：非分段本地播放用 tts.wav，每次覆盖，不堆积
  fs.writeFileSync(wavPath, buf);
  return playWavFile(wavPath, cfg, out);
}

/** 用 ffmpeg -c copy 把多个 wav 合并成一个（要求格式一致，omlx 返回同模型同格式）。返回 {wav} 或 {error}。 */
export function mergeTtsWavs(files, out) {
  // 无 ffmpeg → 不合并，交给调用方依次发送
  let hasFfmpeg = false;
  try { execFileSync('which', ['ffmpeg'], { stdio: 'ignore' }); hasFfmpeg = true; } catch { /* 无 ffmpeg */ }
  if (!hasFfmpeg) return Promise.resolve({ error: 'NO_FFMPEG' });
  return new Promise((resolve) => {
    const merged = `/tmp/dsh_ptt_tts.wav`;
    const list = `/tmp/dsh_ptt_concat.txt`;
    if (files.length === 0) { resolve({ error: '无可合并的 wav' }); return; }
    fs.writeFileSync(list, files.map((f) => `file '${f}'`).join('\n') + '\n');
    // 打印 ffmpeg 命令，方便排查合并
    out?.log?.(`[ptt] 🎬 合并命令: ffmpeg -y -f concat -safe 0 -i ${list} -c copy ${merged}`);
    const p = spawn('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', merged], { stdio: 'ignore' });
    p.on('error', (e) => { fs.rmSync(list, { force: true }); resolve({ error: `ffmpeg 启动失败: ${e?.message ?? e}` }); });
    p.on('exit', (code) => {
      fs.rmSync(list, { force: true });
      if (code === 0 && fs.existsSync(merged)) {
        const wav = fs.readFileSync(merged);
        try { fs.rmSync(merged, { force: true }); } catch { /* ignore */ }
        resolve({ wav });
      } else {
        try { fs.rmSync(merged, { force: true }); } catch { /* ignore */ }
        out?.error?.(`[ptt] ❌ ffmpeg 合并退出码 ${code}`);
        resolve({ error: `ffmpeg 合并退出码 ${code}` });
      }
    });
  });
}
