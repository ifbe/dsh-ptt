// dsh-ptt 插件入口：装配 手柄→录音→ASR→(会话|命令) 链路
// 会话/上下文/LLM 全部交给 DSH（agents 服务），仿 im-qqbot 的插件骨架。
//
// 所有配置来自 profile 的 cordis.patch.yml（ptt 行的 config 段）——
// 那是本插件的唯一配置文件，只影响 ptt profile，不影响其他 profile。
import { startGamepad } from './gamepad.js';
import { transcribe } from './asr.js';
import { SessionBridge } from './session.js';
import { Speaker } from './speaker.js';

export const name = 'ptt';
export const inject = ['agents', 'credentials', 'llm', 'agentDefaultModel', 'commands'];

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
  console.log(`[ptt] 📊 状态: 会话=${st.sessionId ?? '无'} 模型=${st.model} 活跃=${st.active}`);
  speaker.say(`当前会话 ${st.sessionId ?? '无'}，模型 ${st.model}`);
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
    const { agent } = await bridge.ensure();
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

  const bridge = new SessionBridge(agents, cfg, ctx.llm, ctx);
  const speaker = new Speaker(cfg);

  // 启动即恢复/创建会话（不等到首次说话），保持同一会话跨重启
  bridge.ensure().catch((err) => {
    console.error(`[ptt] ⚠️ 会话初始化失败: ${err?.message ?? err}`);
  });

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
        console.log(`[ptt] 📤 发给模型: ${text}`);
        console.log('');
        await bridge.talk(text);
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
        bridge.stop();
        console.log('[ptt] ⏹️ 已发送停止');
        speaker.say('已停止');
      } else if (cmd === 'reset') {
        await bridge.reset();
        console.log('[ptt] 🔄 会话已重置（上下文清空）');
        speaker.say('会话已重置');
      } else {
        console.log(`[ptt] ❓ 未识别的命令: "${text}"（试试: ${[...cfg.STOP_KEYWORDS, ...cfg.RESET_KEYWORDS].slice(0, 6).join(' / ')}）`);
        speaker.say('未识别命令');
      }
    });

  // 手柄事件
  const gamepad = startGamepad(
    {
      onTalkDown: () => {
        console.log('[ptt] 录音中（a键）');
      },
      onTalkUp,
      onCmdDown: () => {
        console.log('[ptt] 录音中（b键）');
      },
      onCmdUp,
      onError: (msg) => logger.error?.(`[ptt] ${msg}`),
    },
    cfg,
    logger,
  );

  // 生命周期：退出时清理
  ctx.effect(() => {
    gamepad.ready.catch((err) => {
      console.error(`[ptt] ❌ ${err?.message ?? err}`);
    });
    return () => {
      gamepad.dispose();
    };
  });

  console.log('[ptt] 对讲机就绪：A键=按住说话，B键=按住说命令（stop/reset）');
  console.log('[ptt] 手柄未接入时插件持续等待，按 Ctrl+C 退出');
}
