// dsh-ptt 插件入口：装配 手柄→录音→ASR→(会话|命令) 链路
// 会话/上下文/LLM 全部交给 DSH（agents 服务），仿 im-qqbot 的插件骨架。
//
// 所有配置来自 profile 的 cordis.patch.yml（ptt 行的 config 段）——
// 那是本插件的唯一配置文件，只影响 ptt profile，不影响其他 profile。
import { startGamepad } from './gamepad.js';
import { startWs } from './ws.js';
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
async function showModels(ctx, speaker) {
  try {
    const providers = ctx.llm.listProviders(); // [{id, name}]
    const lines = [];
    for (const p of providers) {
      try {
        const models = await ctx.llm.listModels(p.id);
        const ids = models.map((m) => m.id).join(', ');
        lines.push(`${p.name ?? p.id}: ${ids || '(空)'}`);
      } catch {
        lines.push(`${p.name ?? p.id}: (模型列表不可用)`);
      }
    }
    console.log('[ptt] 📋 当前可用模型:');
    for (const l of lines) console.log('   ' + l);
    speaker.say(`共有 ${providers.length} 个模型提供方`);
  } catch (err) {
    console.error(`[ptt] ❌ 查询模型失败: ${err?.message ?? err}`);
    speaker.say('查询模型失败');
  }
}

/** 状态命令：显示当前会话信息 */
async function showStatus(bridge, speaker) {
  const st = bridge.getStatus();
  const modeLabel = st.mode === 'assist' ? '辅助(聊天软件会话)' : '独立(ptt会话)';
  console.log(`[ptt] 📊 状态: 模式=${modeLabel} 会话=${st.sessionId ?? '无'} 模型=${st.model ?? '无'} 活跃=${st.active}`);
  speaker.say(`当前模式 ${modeLabel}，会话 ${st.sessionId ?? '无'}`);
}

/** 帮助命令：列出所有语音命令 */
async function showHelp(speaker) {
  const cmds = [
    '停止：中断当前回复',
    '重置：清空上下文开新会话',
    '模型：列出可用模型',
    '压缩：压缩对话历史',
    '目标：查看当前目标',
    '状态：当前会话信息',
    '帮助：列出命令',
  ];
  console.log('[ptt] 📖 语音命令:');
  for (const c of cmds) console.log('   ' + c);
  speaker.say('可用命令：停止、重置、模型、压缩、目标、状态、帮助');
}

/** 执行 DSH 原生命令（compact/goal），打印并播报结果 */
async function runDshCommand(ctx, bridge, line, speaker) {
  try {
    const rec = await bridge.ensure();
    if (!rec) {
      console.log(`[ptt] ⚠️ 无会话：无法执行 ${line}`);
      speaker.say('会话不存在');
      return;
    }
    const { agent } = rec;
    const signal = new AbortController().signal;
    const result = await ctx.commands.execute(agent, line, signal);
    if (!result) {
      console.log(`[ptt] ❓ 命令 ${line} 未识别`);
      speaker.say('命令未识别');
      return;
    }
    const text = result.result?.text ?? JSON.stringify(result.result);
    console.log(`[ptt] 💬 ${line}: ${text}`);
    speaker.say(text.slice(0, 80));
  } catch (err) {
    console.error(`[ptt] ❌ 命令执行失败: ${err?.message ?? err}`);
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

  // ── 环境变量（大写，export 提供；未设则用默认）──
  const ENV_DEFAULTS = {
    INPUT_BUTTON: 'gamepad',   // 按钮输入：gamepad(手柄) | none
    INPUT_AUDIO: 'mic',        // 音频输入：mic(麦克风) | ws
    OUTPUT_TEXT: 'stdout',     // 文本输出：stdout(终端) | none
    OUTPUT_AUDIO: 'speaker',   // 语音输出：speaker(say) | ws
    WS_URL: '',                // ws 输入/输出地址（INPUT_AUDIO=ws 或 OUTPUT_AUDIO=ws 时必填）
  };
  const env = {};
  for (const [name, def] of Object.entries(ENV_DEFAULTS)) {
    const raw = process.env[name];
    console.log(`[ptt] env ${name}=${raw ?? '(未设置)'} → 采用: ${raw ?? def}`);
    env[name] = raw ?? def;
  }
  cfg.INPUT_BUTTON = env.INPUT_BUTTON;
  cfg.INPUT_AUDIO = env.INPUT_AUDIO;
  cfg.OUTPUT_TEXT = env.OUTPUT_TEXT;
  cfg.OUTPUT_AUDIO = env.OUTPUT_AUDIO;
  cfg.WS_URL = env.WS_URL;

  // 启动自检：确认 LLM 凭据可解析
  // （OMLX_API_KEY 存在 ~/.dsh/.credentials.yaml，llm-deepseek 的 apiKeyEnv 指向它）
  // 启动自检：确认 LLM 凭据可解析（OMLX_API_KEY 在 ~/.dsh/.credentials.yaml）
  try {
    const cred = ctx.get('credentials');
    const hit = cred ? await cred.resolve('OMLX_API_KEY') : undefined;
    console.log(`[ptt] LLM 凭据: ${hit ? `OK (来源: ${hit.source ?? '未知'})` : '❌ 缺失'}`);
  } catch (err) {
    console.log(`[ptt] LLM 凭据检查失败: ${err?.message ?? err}`);
  }

  // ── 启动时会话管理：打印全部会话 → 排序打印 → 模式分支 ──
  const bridge = new SessionBridge(agents, cfg, ctx.llm, ctx);
  const speaker = new Speaker(cfg);
  const { mode } = await manageSessions(ctx, bridge);

  if (mode === 'standalone') {
    // 独立模式：启动即恢复/创建 ptt 自己的会话
    bridge.ensure().catch((err) => {
      console.error(`[ptt] ⚠️ 会话初始化失败: ${err?.message ?? err}`);
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
      console.error(`[ptt] ${err?.message ?? err}`);
    });
    return chain;
  };

  // 通用：文本输入（ws 文本 / 语音 ASR 结果）→ 正常对话
  const handleTextInput = (text) =>
    runOnce(async () => {
      if (!text) return;
      console.log(`[ptt] 📤 发给模型: ${text}`);
      console.log('');
      const r = await bridge.talk(text);
      if (r.noSession) {
        console.log('[ptt] ⚠️ 无会话：请先在聊天软件发条消息');
        speaker.say('会话不存在，请先在聊天软件发消息');
      }
    });

  // 通用：wav → ASR → 正常对话
  const handleWavInput = (wav) =>
    runOnce(async () => {
      if (!wav) return;
      console.log('[ptt] 🎯 ASR 识别中...');
      const text = await transcribe(wav, cfg);
      console.log(`[ptt] 📝 ASR: ${text}`);
      if (cfg.ASR_DEBUG) {
        console.log('[ptt] 🔧 调试模式：结果未发给模型');
        return;
      }
      await handleTextInput(text);
    });

  // 通用：wav → ASR → 语音命令（B键逻辑）
  const handleWavCommand = (wav) =>
    runOnce(async () => {
      if (!wav) return;
      console.log('[ptt] 🎯 ASR 识别中...');
      const text = await transcribe(wav, cfg);
      console.log(`[ptt] 📝 ASR: ${text}`);
      if (cfg.ASR_DEBUG) {
        console.log('[ptt] 🔧 调试模式：未执行命令');
        return;
      }
      await handleCommand(text);
    });

  // 通用：执行语音/文本命令（B键 / ws /命令）
  const handleCommand = async (text) => {
    const cmd = matchCommand(text, cfg);
    if (cmd === 'model') {
      await showModels(ctx, speaker);
    } else if (cmd === 'status') {
      await showStatus(bridge, speaker);
    } else if (cmd === 'help') {
      await showHelp(speaker);
    } else if (cmd === 'compact' || cmd === 'goal') {
      await runDshCommand(ctx, bridge, cmd === 'compact' ? '/compact' : '/goal', speaker);
    } else if (cmd === 'stop') {
      if (bridge.stop()) {
        console.log('[ptt] ⏹️ 已发送停止');
        speaker.say('已停止');
      } else {
        console.log('[ptt] ⚠️ 无会话可停止');
        speaker.say('会话不存在');
      }
    } else if (cmd === 'reset') {
      if (await bridge.reset()) {
        console.log('[ptt] 🔄 会话已重置（上下文清空）');
        speaker.say('会话已重置');
      } else {
        console.log('[ptt] ⚠️ 无法重置（辅助模式不重置聊天会话，或无会话）');
        speaker.say('无法重置');
      }
    } else {
      console.log(`[ptt] ❓ 未识别的命令: "${text}"（试试: ${[...cfg.STOP_KEYWORDS, ...cfg.RESET_KEYWORDS].slice(0, 6).join(' / ')}）`);
      speaker.say('未识别命令');
    }
  };

  // A键：py 层已录音生成 wav → ASR → 正常对话
  const onTalkUp = (wav) =>
    runOnce(async () => {
      console.log(`[ptt] 录音完成（a键，${wav ?? '无有效音频'}）`);
      if (!wav) {
        return;
      }
      console.log('[ptt] 🎯 ASR 识别中...');
      const text = await transcribe(wav, cfg);
      console.log(`[ptt] 📝 ASR: ${text}`);
      if (cfg.ASR_DEBUG) {
        console.log('[ptt] 🔧 调试模式：结果未发给模型');
        return;
      }
      if (text) {
        await handleTextInput(text);
      }
    });

  // B键：py 层已录音生成 wav → ASR → 语音命令（不进模型）
  const onCmdUp = (wav) =>
    runOnce(async () => {
      console.log(`[ptt] 录音完成（b键，${wav ?? '无有效音频'}）`);
      if (!wav) {
        return;
      }
      console.log('[ptt] 🎯 ASR 识别中...');
      const text = await transcribe(wav, cfg);
      console.log(`[ptt] 📝 ASR: ${text}`);
      if (cfg.ASR_DEBUG) {
        console.log('[ptt] 🔧 调试模式：未执行命令');
        return;
      }
      await handleCommand(text);
    });

  // ── 输入装配：按钮（手柄）+ 音频（mic/ws）+ ws ──
  let gamepad = { ready: new Promise(() => {}), dispose() {} }; // 未启用时 ready 永不 settle
  if (cfg.INPUT_BUTTON === 'gamepad') {
    // 手柄事件（录音在 py 层；INPUT_AUDIO=mic 时录音由 py 采集）
    gamepad = startGamepad(
      {
        onTalkDown: () => console.log('[ptt] 录音中（a键）'),
        onTalkUp,
        onCmdDown: () => console.log('[ptt] 录音中（b键）'),
        onCmdUp,
        onError: (msg) => logger.error?.(`[ptt] ${msg}`),
      },
      cfg,
      logger,
    );
  } else {
    console.log(`[ptt] 🔘 INPUT_BUTTON=${cfg.INPUT_BUTTON}：不启动手柄`);
  }

  // ws 通道（INPUT_AUDIO=ws 收 wav；文本输入始终支持；OUTPUT_AUDIO=ws 播报输出）
  let wsChannel = { broadcastSpeak() {}, dispose() {} };
  if (cfg.INPUT_AUDIO === 'ws' || cfg.OUTPUT_AUDIO === 'ws' || cfg.WS_URL) {
    wsChannel = startWs(
      {
        onText: (text) => {
          // 以 / 开头 = 命令；否则 = 正常对话文本输入
          if (text.startsWith('/')) {
            console.log(`[ptt] 🕸️ 命令: ${text}`);
            runOnce(() => handleCommand(text.slice(1)));
          } else {
            handleTextInput(text);
          }
        },
        onWav: (wav) => {
          // 音频输入：wav → ASR → 正常对话
          if (cfg.INPUT_AUDIO === 'ws') {
            handleWavInput(wav);
          } else {
            console.log(`[ptt] 🕸️ 收到 wav 但 INPUT_AUDIO=${cfg.INPUT_AUDIO}，忽略`);
          }
        },
        onSpeak: (text) => console.log(`[ptt] 🕸️ 播报→ws: ${text}`),
      },
      cfg.WS_URL,
      logger,
    );
  }

  // ── 输出装配：speaker（say）默认；OUTPUT_AUDIO=ws 时播报转发到 ws ──
  const origSay = speaker.say.bind(speaker);
  if (cfg.OUTPUT_AUDIO === 'ws') {
    speaker.say = (text) => {
      wsChannel.broadcastSpeak(text);
      // ws 模式不本地 say
    };
  } else {
    speaker.say = origSay;
  }

  // 生命周期：退出时清理
  ctx.effect(() => {
    gamepad.ready.catch((err) => {
      console.error(`[ptt] ❌ ${err?.message ?? err}`);
    });
    return () => {
      gamepad.dispose();
      wsChannel.dispose();
    };
  });

  console.log('[ptt] 对讲机就绪：A键=按住说话，B键=按住说命令（stop/reset）');
  console.log(`[ptt] 输入: 按钮=${cfg.INPUT_BUTTON} 音频=${cfg.INPUT_AUDIO} | 输出: 文本=${cfg.OUTPUT_TEXT} 语音=${cfg.OUTPUT_AUDIO}`);
}
