// 输出：把 DSH 的 session/event（assistant/chunk 流式文本）打印到终端，
// turn/end 时整段用 macOS `say` 播报。事件结构对齐 qqbot 的 events.js。
//
// DSH 的 chunk 流没有 <think> 标签，用结构化块：
//   - reasoning-delta：think/思考内容 → 终端置灰显示（💭 开头），不播报
//   - text-delta：正常回复 → 终端正常显示，turn/end 播报
//
// 所有 stdout 输出走统一队列（_write），避免流式 chunk 与日志/工具打印交错。
import { spawn } from 'node:child_process';

/** 从消息 content 数组提取文本（递归处理 tool-result） */
function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (c?.type === 'tool-result') return extractText(c?.content);
      return typeof c?.text === 'string' ? c.text : '';
    })
    .filter(Boolean)
    .join(' ');
}

const ANSI_GRAY = '\x1b[90m'; // 灰色（think）
const ANSI_LIGHT_RED = '\x1b[91m'; // 浅红（工具调用）
const ANSI_LIGHT_BLUE = '\x1b[94m'; // 浅蓝（工具结果）
const ANSI_RESET = '\x1b[0m';

export class Speaker {
  /** @param {object} config @param {(text:string)=>void} onReply turn/end 文本回调
   *  @param {{write:(s:string)=>void,log:(...a:unknown[])=>void,error:(...a:unknown[])=>void}} out 全局共享输出队列 */
  constructor(config, onReply, out) {
    this.config = config;
    this.onReply = onReply;
    this.out = out;
    this.pending = ''; // 正常回复（播报用）
    this.pendingReasoning = ''; // think 内容（ws 文本输出用）
    this.sayQueue = []; // say 输出队列（串行播放，不并发不丢弃）
    this.playing = false;
  }

  /** 统一 stdout 输出：走全局共享队列（与输入日志同队列，防交错） */
  _write(s) {
    this.out.write(s);
  }

  /** 处理一条 DSH session/event */
  handleEvent(evt) {
    // 大type（event.type）或小type（chunk.type）任一变化都打一行
    const ck = evt.data?.chunk;
    const smallType = ck?.type ?? '';
    if (evt.type !== this._lastEventType || (smallType && smallType !== this._lastChunkType)) {
      this._lastEventType = evt.type;
      if (smallType) this._lastChunkType = smallType;
      // 附加内容：chunk 级（usage/tool-call-delta/finish）+ event 级（各类型关键信息）
      let detail = '';
      if (ck?.type === 'usage' && ck.usage) {
        const u = ck.usage;
        detail = ` input=${u.inputTokens ?? '?'} output=${u.outputTokens ?? '?'} cache=${u.cacheReadTokens ?? '?'}`;
      } else if (ck?.type === 'tool-call-delta' && ck.text) {
        detail = ` ${ck.text}`;
      } else if (ck?.type === 'finish') {
        detail = ` reason=${JSON.stringify(ck.reason ?? {})}`;
      } else if (evt.type === 'user/message') {
        detail = ` ${extractText(evt.data?.content).slice(0, 200)}`;
      } else if (evt.type === 'assistant/message') {
        // 内容与 chunk 流重复，不打印具体内容
        detail = '';
      } else if (evt.type === 'request/header') {
        const c = evt.data?.header?.config;
        detail = c ? ` provider=${c.provider} model=${c.model}` : '';
      } else if (evt.type === 'request/context') {
        detail = ` ${JSON.stringify(evt.data).slice(0, 200)}`;
      } else if (evt.type === 'session/title') {
        detail = ` title=${evt.data?.title ?? ''}`;
      } else if (evt.type === 'turn/start' || evt.type === 'turn/end') {
        detail = ` turn=${evt.data?.turn ?? ''}`;
      } else if (evt.type === 'step/start' || evt.type === 'step/end') {
        detail = ` step=${evt.data?.step ?? ''}`;
      } else if (evt.type === 'agent/inbox/spliced') {
        detail = ` ${JSON.stringify(evt.data).slice(0, 150)}`;
      } else if (evt.type === 'session/title-llm-request') {
        detail = ` ${JSON.stringify(evt.data).slice(0, 100)}`;
      }
      this._write(`[ptt] 📡 event: event.type=${evt.type} chunk.type=${smallType || '-'}${detail}\n`);
    }

    // 工具调用：命令 + 参数（浅红；不进播报队列）
    if (evt.type === 'tool/call') {
      const d = evt.data ?? {};
      let args = '';
      try {
        const a = JSON.parse(d.arguments ?? '{}');
        args = a.command ?? a.pattern ?? a.path ?? d.arguments ?? '';
      } catch {
        args = d.arguments ?? '';
      }
      this._write(`\n${ANSI_LIGHT_RED}🛠️ 工具调用: ${d.name} ${args}${ANSI_RESET}\n`);
      return;
    }
    // 工具结果（浅蓝；不进播报队列）
    if (evt.type === 'tool/result') {
      const d = evt.data ?? {};
      const texts = [];
      try {
        for (const c of d.message?.content ?? []) {
          if (c.type === 'tool-result') {
            for (const t of c.content ?? []) {
              if (t.type === 'text') texts.push(t.text);
            }
          }
        }
      } catch { /* 忽略 */ }
      const joined = texts.join('');
      const err = d.error ? `错误: ${typeof d.error === 'string' ? d.error : JSON.stringify(d.error)}` : '';
      const summary = joined.length > 300 ? `${joined.slice(0, 300)}…` : joined;
      this._write(`${ANSI_LIGHT_BLUE}📦 工具结果${err ? ` (${err})` : ''}: ${summary || '(空)'}${ANSI_RESET}\n`);
      return;
    }
    if (evt.type === 'assistant/chunk') {
      const chunk = evt.data?.chunk;
      // （切换打印统一在 handleEvent 入口处理）
      if (chunk?.type === 'reasoning-delta' && chunk.text) {
        // think：💭 emoji 开头（块内只一次）+ 灰色内容（不进入播报）
        this.pendingReasoning += chunk.text;
        if (this.config.OUTPUT_TEXT !== 'none') {
          if (!this.inReasoning) {
            this._write(`${ANSI_GRAY}💭 `);
            this.inReasoning = true;
            // 模型 reasoning 内容以 \n 开头，块首去掉（否则 💭 后看起来强制换行）
            const t = chunk.text.replace(/^\n+/, '');
            if (t) this._write(`${ANSI_GRAY}${t}${ANSI_RESET}`);
          } else {
            this._write(`${ANSI_GRAY}${chunk.text}${ANSI_RESET}`);
          }
        }
      } else if (chunk?.type === 'text-delta' && chunk.text) {
        // 正常回复：正常颜色显示 + 累积待播报
        this.inReasoning = false;
        this.pending += chunk.text;
        if (this.config.OUTPUT_TEXT !== 'none') this._write(chunk.text);
      }
      return;
    }
    if (evt.type === 'turn/end') {
      const text = this.pending.trim();
      const thinkText = this.pendingReasoning.trim();
      this.pending = '';
      this.pendingReasoning = '';
      this.inReasoning = false;
      if (this.config.OUTPUT_TEXT !== 'none' && text) {
        this._write('\n\n'); // 回复后两个回车：文本换行 + 空行
      }
      if (text || thinkText) {
        // 文本输出回调：think 与 reply 分开传（ws 广播可标不同标签）
        this.onReply?.({ think: thinkText, reply: text });
        if (this.config.OUTPUT_AUDIO === 'ws') {
          // ws 输出：完整播报，不截断（客户端自己处理）
          this.say(text);
        } else if (text.length > 100) {
          // 本地 say：前 100 字正常念，第 101 起省略并提示总字数
          this.say(`${text.slice(0, 100)}……模型总共回复了 ${text.length} 个字`);
        } else {
          this.say(text);
        }
      }
      this._write(`[ptt] 📡 turn/end: ${JSON.stringify(evt.data?.reason ?? {}).slice(0, 120)}\n`);
      const reason = evt.data?.reason;
      if (reason?.kind === 'error') {
        const detail = reason.error ?? reason.failure;
        this._write(`\n[ptt] turn error: ${detail?.message ?? 'unknown'}\n`);
      }
    }
  }

  /** 语音播报：入队串行播放（不并发不丢弃） */
  say(text) {
    if (this.config.PTT_TTS === 'none' || !this.config.SPEAK_REPLY) return;
    this.sayQueue.push(text);
    this._pump();
  }

  _pump() {
    if (this.playing || this.sayQueue.length === 0) return;
    const text = this.sayQueue.shift();
    // 截断超长文本，避免单条 say 卡死
    const t = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    this.playing = true;
    const p = spawn('say', ['-v', this.config.VOICE_NAME, t], { stdio: 'ignore' });
    p.on('exit', () => {
      this.playing = false;
      this._pump(); // 播完下一条
    });
  }
}
