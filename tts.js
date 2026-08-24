// tts.js — 文字合成语音。PTT_TTS 选择合成器：
//   say    → macOS 本地 say（-o 生成 wav / 直接播）
//   openai → omlx /v1/audio/speech（OpenAI 兼容，返回 wav）
//   none   → 禁用
// 用途分成两种：拿 wav 缓冲（ws 广播/本地播放），或直接本地播放。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';

/** macOS say -o 生成 wav 文件 */
async function sayWav(text, cfg) {
  const wavPath = `/tmp/dsh_ptt_tts_${Date.now()}.wav`;
  await new Promise((resolve, reject) => {
    const p = spawn('say', ['-v', cfg.VOICE_NAME, '-o', wavPath, '--data-format=LEI16@16000', text]);
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`say 退出码 ${code}`))));
  });
  const buf = fs.readFileSync(wavPath);
  fs.rmSync(wavPath, { force: true });
  return buf;
}

/** openai：调 omlx /v1/audio/speech → wav 缓冲 */
async function openaiWav(text, cfg) {
  const baseUrl = (cfg.PTT_TTS_URL || cfg.OMLX_BASE_URL || '').replace(/\/$/, '');
  const apiKey = cfg.PTT_TTS_KEY || cfg.OMLX_API_KEY || '';
  const model = cfg.PTT_TTS_MODEL || 'Qwen3-TTS-12Hz-0.6B-Base-4bit';
  const voice = cfg.PTT_TTS_VOICE || 'alloy';
  const body = JSON.stringify({ model, input: text, voice });
  const res = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 生成语音 wav 缓冲。返回 {wav: Buffer} 或 {error: string}。
 * @param text 要朗读的文本
 * @param cfg 插件配置（PTT_TTS / VOICE_NAME / OMLX_BASE_URL / PTT_TTS_*）
 */
export async function ttsWav(text, cfg) {
  try {
    if (cfg.PTT_TTS === 'none') return { error: '无有效TTS工具（PTT_TTS=none）' };
    if (cfg.PTT_TTS === 'openai') return { wav: await openaiWav(text, cfg) };
    if (cfg.PTT_TTS === 'say') return { wav: await sayWav(text, cfg) };
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

/**
 * 本地播放一段 wav 缓冲。返回 null 成功，或错误字符串。
 * @param buf wav 缓冲
 * @param cfg
 */
export function playWavBuffer(buf, cfg) {
  const player = cfg.LOCAL_PLAYER ?? resolvePlayer(cfg);
  if (!player) return '没有可用的本地播放器（afplay/aplay/paplay/ffplay）';
  const wavPath = `/tmp/dsh_ptt_play_${Date.now()}.wav`;
  fs.writeFileSync(wavPath, buf);
  return new Promise((resolve) => {
    const p = spawn(player, [wavPath], { stdio: 'ignore' });
    const cleanup = () => { try { fs.rmSync(wavPath, { force: true }); } catch { /* ignore */ } };
    p.on('error', (e) => { cleanup(); resolve(`播放器启动失败（${e?.message ?? e}）`); });
    p.on('exit', (code) => { cleanup(); resolve(code === 0 ? null : `播放器退出码 ${code}`); });
  });
}
