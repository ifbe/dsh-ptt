// dsh-ptt 插件入口：装配 手柄→录音→ASR→(会话|命令) 链路
// 会话/上下文/LLM 全部交给 DSH（agents 服务），仿 im-qqbot 的插件骨架。
//
// 所有配置来自 profile 的 cordis.patch.yml（ptt 行的 config 段）——
// 那是本插件的唯一配置文件，只影响 ptt profile，不影响其他 profile。
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import { startGamepad } from './gamepad.js';
import { startWs } from './ws.js';
import { createOutputQueue } from './out.js';

// 全局 stdout 队列（模块级：apply 内外的函数共用，防交错）
const out = createOutputQueue();
import { transcribe } from './asr.js';
import { SessionBridge, manageSessions } from './session.js';
import { Speaker } from './speaker.js';

export const name = 'ptt';
export const inject = ['agents', 'credentials', 'llm', 'agentDefaultModel', 'commands', 'sessionPersistence'];

// ── 代码兜底默认值（patch 里没配的字段用这里；正式配置在 cordis.patch.yml）──
const DEFAULTS = {
  OMLX_BASE_URL: 'http://macmini.local:12345/v1',
  OMLX_API_KEY: '52755227',
  ASR_MODEL: 'Qwen3-ASR-0.6B-4bit',
  LLM_MODEL: 'Qwen3.6-35B-A3B-4bit',
  LLM_PROVIDER: 'omlx',
  SESSION_KEY: 'ptt-main', // 会话标识：改这个 = 换一个全新主会话（历史互不相通）
  GAMEPAD_BACKEND: 'node-hid',
  PYTHON_BIN: 'python3',
  BUTTON_TALK: 0,
  BUTTON_CMD: 1,
  RECORDER_BIN: 'rec',  // macOS: rec(sox) 稳定；ffmpeg avfoundation 有启动慢/短录音问题
  AUDIO_DEVICE: ':0',
  SAMPLE_RATE: 16000,
  MAX_RECORD_SEC: 30,
  VOICE_NAME: 'Ting-Ting',
  SPEAK_REPLY: true,
  STOP_KEYWORDS: ['stop', '停止', '别说了', '闭嘴', '停下'],
  RESET_KEYWORDS: ['reset', '重置', '清空', '重来', '新会话'],
  MODEL_KEYWORDS: ['model', '模型', '可用模型', '有哪些模型'],
  STATUS_KEYWORDS: ['status', '状态', '当前状态'],
  HELP_KEYWORDS: ['help', '帮助', '有什么命令', '有哪些命令'],
  COMPACT_KEYWORDS: ['compact', '压缩', '压缩一下'],
  GOAL_KEYWORDS: ['goal', '目标', '当前目标'],

  // 调试：true 时 ASR 结果只打印，不发给模型、不执行命令
  ASR_DEBUG: false,
};

/** 列出 DSH 注册的所有 provider 及其可用模型（ctx.llm 标准机制） */
async function showModels(ctx, speaker, wsText) {
  try {
    const providers = ctx.llm.listProviders(); // [{id, name}]
    const lines = [];
    for (const p of providers) {
      try {
        const models = await ctx.llm.listModels(p.id);
        // 模型名后标注能力（inputModalities：text/image/audio）
        const ids = models.map((m) => {
          const mods = m.inputModalities ?? [];
          const caps = mods.length ? ` (${mods.join('/')})` : '';
          return `${m.id}${caps}`;
        }).join(', ');
        lines.push(`${p.name ?? p.id}: ${ids || '(空)'}`);
      } catch {
        lines.push(`${p.name ?? p.id}: (模型列表不可用)`);
      }
    }
    out.log('[ptt] 📋 当前可用模型:');
    for (const l of lines) out.log('   ' + l);
    const modelText = `可用模型：\n${lines.join('\n')}`;
    wsText?.(modelText);
    speaker.say(modelText);
  } catch (err) {
    out.error(`[ptt] ❌ 查询模型失败: ${err?.message ?? err}`);
    wsText?.(`查询模型失败：${err?.message ?? err}`);
    speaker.say('查询模型失败');
  }
}

/** 状态命令：显示当前会话信息 */
async function showStatus(bridge, speaker, wsText) {
  const st = bridge.getStatus();
  const modeLabel = st.mode === 'assist' ? '辅助(聊天软件会话)' : '独立(ptt会话)';
  out.log(`[ptt] 📊 状态: 模式=${modeLabel} 会话=${st.sessionId ?? '无'} 模型=${st.model ?? '无'} 活跃=${st.active}`);
  const statusText = `状态：模式=${modeLabel} 会话=${st.sessionId ?? '无'} 模型=${st.model ?? '无'} 活跃=${st.active}`;
  wsText?.(statusText);
  speaker.say(statusText);
}

/** 帮助命令：列出所有语音命令 */
async function showHelp(speaker, wsText) {
  const cmds = [
    '停止：中断当前回复',
    '重置：清空上下文开新会话',
    '模型：列出可用模型',
    '压缩：压缩对话历史',
    '目标：查看当前目标',
    '状态：当前会话信息',
    '帮助：列出命令',
  ];
  out.log('[ptt] 📖 语音命令:');
  for (const c of cmds) out.log('   ' + c);
  const helpText = `语音命令：\n${cmds.join('\n')}`;
  wsText?.(helpText);
  speaker.say(helpText);
}

/** 执行 DSH 原生命令（compact/goal），打印并播报结果 */
async function runDshCommand(ctx, bridge, line, speaker, wsText) {
  try {
    const rec = await bridge.ensure();
    if (!rec) {
      out.log(`[ptt] ⚠️ 无会话：无法执行 ${line}`);
      speaker.say('会话不存在');
      return;
    }
    const { agent } = rec;
    const signal = new AbortController().signal;
    const result = await ctx.commands.execute(agent, line, signal);
    if (!result) {
      out.log(`[ptt] ❓ 命令 ${line} 未识别`);
      speaker.say('命令未识别');
      return;
    }
    const text = result.result?.text ?? JSON.stringify(result.result);
    out.log(`[ptt] 💬 ${line}: ${text}`);
    const cmdText = `${line} ${text}`;
    wsText?.(cmdText);
    speaker.say(cmdText);
  } catch (err) {
    out.error(`[ptt] ❌ 命令执行失败: ${err?.message ?? err}`);
    speaker.say('命令执行失败');
  }
}

// B键语音命令 → 关键词匹配（大小写不敏感；中英文都可加，见 cordis.patch.yml）
function matchCommand(text, config) {
  const t = text.toLowerCase();
  if (config.STOP_KEYWORDS.some((k) => t.includes(k.toLowerCase()))) return 'stop';
  if (config.RESET_KEYWORDS.some((k) => t.includes(k.toLowerCase()))) return 'reset';
  if (config.MODEL_KEYWORDS.some((k) => t.includes(k.toLowerCase()))) return 'model';
  if (config.STATUS_KEYWORDS.some((k) => t.includes(k.toLowerCase()))) return 'status';
  if (config.HELP_KEYWORDS.some((k) => t.includes(k.toLowerCase()))) return 'help';
  if (config.COMPACT_KEYWORDS.some((k) => t.includes(k.toLowerCase()))) return 'compact';
  if (config.GOAL_KEYWORDS.some((k) => t.includes(k.toLowerCase()))) return 'goal';
  return null;
}

export async function apply(ctx, config) {
  const agents = ctx.agents;
  const logger = ctx.logger ?? console;
  const cfg = { ...DEFAULTS, ...(config ?? {}) };

  // ── 环境变量（PTT_ 前缀防冲突，export 提供；未设则用默认）──
  const ENV_DEFAULTS = {
    PTT_INPUT_TEXT: 'stdin',       // 文本输入：stdin(回车一行) | ws | none
    PTT_INPUT_AUDIO: 'gamepad',    // 音频输入：gamepad(手柄+录音,gamepad.py) | mic(纯麦克风) | ws | none
    PTT_OUTPUT_TEXT: 'stdout',     // 文本输出：stdout(终端) | ws | none
    PTT_OUTPUT_AUDIO: 'auto',      // 语音输出：say(macOS) | ws | none；auto=自动检测（macOS+有say才say，否则none）
    PTT_MODEL: '',                 // LLM 模型 provider/model（如 omlx/Qwen3.6-35B-A3B-4bit），空=用配置
    PTT_WS_URL: '',                // ws 输入/输出地址（PTT_INPUT_AUDIO=ws 或 PTT_OUTPUT_AUDIO=ws 时必填）
    PTT_TTS: 'say',                // 语音合成：say(macOS) | none
    PTT_ASR: 'openai',             // ASR 方式：openai(OpenAI 兼容) | none
    PTT_ASR_URL: '',               // ASR 端点（默认用 OMLX_BASE_URL）
    PTT_ASR_API: 'transcribe',     // ASR API 路径（transcribe = /audio/transcriptions）
    PTT_ASR_KEY: '',               // ASR key（默认用 OMLX_API_KEY）
    PTT_ASR_MODEL: '',             // ASR 模型名（默认用 ASR_MODEL）
  };
  // 读取原始值 → 计算最终采用（env 优先 → 默认；ASR 空值回退配置）
  const envRaw = {};
  for (const name of Object.keys(ENV_DEFAULTS)) {
    envRaw[name] = process.env[name] ?? '(未设置)';
  }
  const env = {};
  for (const [name, def] of Object.entries(ENV_DEFAULTS)) {
    env[name] = process.env[name] ?? def;
  }
  env.PTT_ASR_URL ||= cfg.OMLX_BASE_URL ?? '';
  env.PTT_ASR_KEY ||= cfg.OMLX_API_KEY ?? '';
  env.PTT_ASR_MODEL ||= cfg.ASR_MODEL ?? '';
  // PTT_OUTPUT_AUDIO=auto：检测 macOS + say 命令，没有则 none（树莓派等 Linux 无 say）
  if (env.PTT_OUTPUT_AUDIO === 'auto') {
    let hasSay = false;
    try {
      execFileSync('which', ['say'], { stdio: 'ignore' });
      hasSay = process.platform === 'darwin';
    } catch { /* 无 say */ }
    env.PTT_OUTPUT_AUDIO = hasSay ? 'say' : 'none';
  }
  // PTT_MODEL=provider/model → 覆盖 LLM 配置
  if (env.PTT_MODEL) {
    const slash = env.PTT_MODEL.indexOf('/');
    if (slash > 0 && slash < env.PTT_MODEL.length - 1) {
      cfg.LLM_PROVIDER = env.PTT_MODEL.slice(0, slash);
      cfg.LLM_MODEL = env.PTT_MODEL.slice(slash + 1);
    } else {
      out.log(`[ptt] ⚠️ PTT_MODEL 格式错误（应为 provider/model）: ${env.PTT_MODEL}`);
    }
  }
  // 同一行打印：读取值 + 最终值
  for (const name of Object.keys(ENV_DEFAULTS)) {
    out.log(`[ptt] env ${name} 读取=${envRaw[name]} 最终=${env[name] || '(空)'}`);
  }
  cfg.INPUT_AUDIO = env.PTT_INPUT_AUDIO;
  cfg.INPUT_TEXT = env.PTT_INPUT_TEXT;
  cfg.OUTPUT_TEXT = env.PTT_OUTPUT_TEXT;
  cfg.OUTPUT_AUDIO = env.PTT_OUTPUT_AUDIO;
  cfg.WS_URL = env.PTT_WS_URL;
  cfg.PTT_TTS = env.PTT_TTS;
  cfg.PTT_ASR = env.PTT_ASR;
  cfg.PTT_ASR_URL = env.PTT_ASR_URL;
  cfg.PTT_ASR_API = env.PTT_ASR_API;
  cfg.PTT_ASR_KEY = env.PTT_ASR_KEY;
  cfg.PTT_ASR_MODEL = env.PTT_ASR_MODEL;

  // 启动自检：确认 LLM 凭据可解析
  // （OMLX_API_KEY 存在 ~/.dsh/.credentials.yaml，llm-deepseek 的 apiKeyEnv 指向它）
  // 启动自检：确认 LLM 凭据可解析（OMLX_API_KEY 在 ~/.dsh/.credentials.yaml）
  try {
    const cred = ctx.get('credentials');
    const hit = cred ? await cred.resolve('OMLX_API_KEY') : undefined;
    out.log(`[ptt] LLM 凭据: ${hit ? `OK (来源: ${hit.source ?? '未知'})` : '❌ 缺失'}`);
  } catch (err) {
    out.log(`[ptt] LLM 凭据检查失败: ${err?.message ?? err}`);
  }

  // ── 启动时会话管理：打印全部会话 → 排序打印 → 模式分支 ──
  const bridge = new SessionBridge(agents, cfg, ctx.llm, ctx);
  const speaker = new Speaker(cfg, ({ think, reply }) => {
    // 文本输出回调（turn/end 时）：OUTPUT_TEXT=ws → 广播（think/reply 标不同标签）
    if (cfg.OUTPUT_TEXT === 'ws') {
      if (think) wsChannel.broadcastText(think, 'think');
      if (reply) wsChannel.broadcastText(reply, 'reply');
    }
  }, out);
  const { mode } = await manageSessions(ctx, bridge);

  if (mode === 'standalone') {
    // 独立模式：启动即恢复/创建 ptt 自己的会话
    bridge.ensure().catch((err) => {
      out.error(`[ptt] ⚠️ 会话初始化失败: ${err?.message ?? err}`);
    });
  }
  // 辅助模式：不创建 ptt 会话，只绑定 IM 会话（无会话时 ASR 会提示）

  // 模型回复：流式打印 + turn/end 播报
  // 注意：session/event 是 (subject, event) 双参数，event 才是 {type, data}
  ctx.on('session/event', (subject, event) => speaker.handleEvent(event));

  // 单次「录音 → ASR → 处理」流程
  let chain = Promise.resolve();
  const runOnce = (fn) => {
    chain = chain.then(fn).catch((err) => {
      out.error(`[ptt] ${err?.message ?? err}`);
    });
    return chain;
  };

  // 通用：文本输入（ws 文本 / 语音 ASR 结果 / stdin）→ 正常对话
  // 注意：不做 runOnce（由事件入口统一串行，避免嵌套 runOnce 死锁）
  const handleTextInput = async (text) => {
    if (!text) return;
    out.log(`[ptt] 📤 发给模型: ${text}`);
    out.log('');
    const r = await bridge.talk(text);
    if (r.noSession) {
      out.log('[ptt] ⚠️ 无会话：请先在聊天软件发条消息');
      speaker.say('会话不存在，请先在聊天软件发消息');
    }
  };

  // 通用：wav → ASR → 正常对话（不做 runOnce，由事件入口统一串行）
  const handleWavInput = async (wav) => {
    if (!wav) return;
    out.log('[ptt] 🎯 ASR 识别中...');
    const text = await transcribe(wav, cfg);
    out.log(`[ptt] 📝 ASR: ${text}`);
    if (cfg.ASR_DEBUG) {
      out.log('[ptt] 🔧 调试模式：结果未发给模型');
      return;
    }
    await handleTextInput(text);
  };

  // 通用：wav → ASR → 语音命令（B键逻辑，不做 runOnce）
  const handleWavCommand = async (wav) => {
    if (!wav) return;
    out.log('[ptt] 🎯 ASR 识别中...');
    const text = await transcribe(wav, cfg);
    out.log(`[ptt] 📝 ASR: ${text}`);
    if (cfg.ASR_DEBUG) {
      out.log('[ptt] 🔧 调试模式：未执行命令');
      return;
    }
    await handleCommand(text);
  };

  // 通用：执行语音/文本命令（B键 / ws /命令）
  const handleCommand = async (text) => {
    const cmd = matchCommand(text, cfg);
    // 命令反馈：OUTPUT_TEXT=ws 时也广播文本（网页可看到命令结果）
    const wsText = (t) => {
      if (cfg.OUTPUT_TEXT === 'ws') wsChannel.broadcastText(t, 'reply');
    };
    if (cmd === 'model') {
      await showModels(ctx, speaker, wsText);
    } else if (cmd === 'status') {
      await showStatus(bridge, speaker, wsText);
    } else if (cmd === 'help') {
      await showHelp(speaker, wsText);
    } else if (cmd === 'compact' || cmd === 'goal') {
      await runDshCommand(ctx, bridge, cmd === 'compact' ? '/compact' : '/goal', speaker, wsText);
    } else if (cmd === 'stop') {
      if (bridge.stop()) {
        out.log('[ptt] ⏹️ 已发送停止');
        wsText?.('已停止');
        speaker.say('已停止');
      } else {
        out.log('[ptt] ⚠️ 无会话可停止');
        wsText?.('无会话可停止');
        speaker.say('无会话可停止');
      }
    } else if (cmd === 'reset') {
      if (await bridge.reset()) {
        out.log('[ptt] 🔄 会话已重置（上下文清空）');
        wsText?.('会话已重置（上下文清空）');
        speaker.say('会话已重置（上下文清空）');
      } else {
        out.log('[ptt] ⚠️ 无法重置（辅助模式不重置聊天会话，或无会话）');
        wsText?.('无法重置（辅助模式不重置聊天会话，或无会话）');
        speaker.say('无法重置');
      }
    } else {
      out.log(`[ptt] ❓ 未识别的命令: "${text}"（试试: ${[...cfg.STOP_KEYWORDS, ...cfg.RESET_KEYWORDS].slice(0, 6).join(' / ')}）`);
      speaker.say('未识别命令');
    }
  };

  // A键：py 层已录音生成 wav → ASR → 正常对话
  const onTalkUp = (wav) =>
    runOnce(async () => {
      out.log(`[ptt] 录音完成（a键，${wav ?? '无有效音频'}）`);
      if (!wav) {
        return;
      }
      out.log('[ptt] 🎯 ASR 识别中...');
      const text = await transcribe(wav, cfg);
      out.log(`[ptt] 📝 ASR: ${text}`);
      if (cfg.ASR_DEBUG) {
        out.log('[ptt] 🔧 调试模式：结果未发给模型');
        return;
      }
      if (text) {
        await handleTextInput(text);
      }
    });

  // B键：py 层已录音生成 wav → ASR → 语音命令（不进模型）
  const onCmdUp = (wav) =>
    runOnce(async () => {
      out.log(`[ptt] 录音完成（b键，${wav ?? '无有效音频'}）`);
      if (!wav) {
        return;
      }
      out.log('[ptt] 🎯 ASR 识别中...');
      const text = await transcribe(wav, cfg);
      out.log(`[ptt] 📝 ASR: ${text}`);
      if (cfg.ASR_DEBUG) {
        out.log('[ptt] 🔧 调试模式：未执行命令');
        return;
      }
      await handleCommand(text);
    });

  // ── 输入装配：按钮（手柄）+ 音频（mic/ws）+ ws ──
  let gamepad = { ready: new Promise(() => {}), dispose() {} }; // 未启用时 ready 永不 settle
  if (cfg.INPUT_AUDIO === 'gamepad') {
    // gamepad.py 套件：手柄 A/B 键 + 麦克风录音（原先那套）
    gamepad = startGamepad(
      {
        onTalkDown: () => out.log('[ptt] 录音中（a键）'),
        onTalkUp,
        onCmdDown: () => out.log('[ptt] 录音中（b键）'),
        onCmdUp,
        onError: (msg) => logger.error?.(`[ptt] ${msg}`),
      },
      cfg,
      logger,
    );
  } else if (cfg.INPUT_AUDIO === 'mic') {
    out.log('[ptt] 🎙️ INPUT_AUDIO=mic：纯麦克风（暂无触发方式，待 VAD）');
  } else if (cfg.INPUT_AUDIO !== 'ws') {
    out.log(`[ptt] 🎙️ INPUT_AUDIO=${cfg.INPUT_AUDIO}：无音频输入`);
  }

  // ws 通道（INPUT_AUDIO=ws 收 wav；文本输入始终支持；OUTPUT_AUDIO=ws 播报输出）
  let wsChannel = { broadcastSpeak() {}, dispose() {} };
  if (cfg.INPUT_AUDIO === 'ws' || cfg.OUTPUT_AUDIO === 'ws' || cfg.WS_URL) {
    wsChannel = startWs(
      {
        onText: (text) => {
          // 以 / 开头 = 命令；否则 = 正常对话文本输入
          if (text.startsWith('/')) {
            out.log(`[ptt] 🕸️ 命令: ${text}`);
            runOnce(() => handleCommand(text.slice(1)));
          } else {
            runOnce(() => handleTextInput(text));
          }
        },
        onWav: (wav) => {
          // 音频输入：wav → ASR → 正常对话
          if (cfg.INPUT_AUDIO === 'ws') {
            runOnce(() => handleWavInput(wav));
          } else {
            out.log(`[ptt] 🕸️ 收到 wav 但 INPUT_AUDIO=${cfg.INPUT_AUDIO}，忽略`);
          }
        },
        onSpeak: (text) => out.log(`[ptt] 🕸️ 播报→ws: ${text}`),
      },
      cfg.WS_URL,
      logger,
    );
  }

  // ── 文本输入装配：INPUT_TEXT=stdin 读一行（回车提交）──
  let stdinRl = null;
  if (cfg.INPUT_TEXT === 'stdin') {
    stdinRl = readline.createInterface({ input: process.stdin });
    stdinRl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      out.log(`[ptt] ⌨️ stdin: ${text}`);
      if (text.startsWith('/')) {
        runOnce(() => handleCommand(text.slice(1)));
      } else {
        runOnce(() => handleTextInput(text));
      }
    });
    out.log('[ptt] ⌨️ 文本输入: stdin（回车提交一行；/ 开头=命令）');
  } else if (cfg.INPUT_TEXT === 'ws') {
    out.log('[ptt] ⌨️ 文本输入: ws（ws 文本消息）');
  } else {
    out.log(`[ptt] ⌨️ 文本输入: ${cfg.INPUT_TEXT}（无文本输入）`);
  }

  // ── 输出装配：OUTPUT_AUDIO=say 本地 say；=ws 生成 wav 经 ws 广播；=none 静默 ──
  const origSay = speaker.say.bind(speaker);
  if (cfg.OUTPUT_AUDIO === 'none') {
    speaker.say = () => {}; // 无语音输出
  } else if (cfg.OUTPUT_AUDIO === 'ws') {
    speaker.say = (text) => {
      // say -o 生成 wav → base64 广播给 ws 客户端（由客户端播报）
      const wavPath = `/tmp/dsh_ptt_say_${Date.now()}.wav`;
      const p = spawn('say', ['-v', cfg.VOICE_NAME, '-o', wavPath, '--data-format=LEI16@16000', text], { stdio: 'ignore' });
      p.on('exit', () => {
        try {
          const buf = fs.readFileSync(wavPath);
          wsChannel.broadcastAudio(buf); // 二进制 wav 直发
          fs.rmSync(wavPath, { force: true });
        } catch { /* 生成失败忽略 */ }
      });
    };
  } else {
    speaker.say = origSay;
  }

  // 生命周期：退出时清理
  ctx.effect(() => {
    gamepad.ready.catch((err) => {
      out.error(`[ptt] ❌ ${err?.message ?? err}`);
    });
    return () => {
      gamepad.dispose();
      wsChannel.dispose();
      stdinRl?.close();
    };
  });

  out.log('[ptt] 对讲机就绪：A键=按住说话，B键=按住说命令（stop/reset）');
  out.log(`[ptt] 输入: 音频=${cfg.INPUT_AUDIO} 文本=${cfg.INPUT_TEXT} | 输出: 文本=${cfg.OUTPUT_TEXT} 语音=${cfg.OUTPUT_AUDIO}`);
}
