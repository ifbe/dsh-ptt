// 输出：把 DSH 的 session/event（assistant/chunk 流式文本）打印到终端，
// turn/end 时整段用 macOS `say` 播报。事件结构对齐 qqbot 的 events.js。
import { spawn } from 'node:child_process';

export class Speaker {
  /** @param {object} config */
  constructor(config) {
    this.config = config;
    this.pending = '';
    this.busy = false;
  }

  /** 处理一条 DSH session/event */
  handleEvent(evt) {
    if (evt.type === 'assistant/chunk') {
      // 每 20 块打一次进度，避免刷屏
      if (this._chunks === undefined) this._chunks = 0;
      if (this._chunks % 20 === 0) console.log(`[ptt] 📡 收到模型流: chunk#${this._chunks}`);
      this._chunks++;
      const chunk = evt.data?.chunk;
      if (chunk?.type === 'text-delta' && chunk.text) {
        this.pending += chunk.text;
        process.stdout.write(chunk.text);
      }
      return;
    }
    if (evt.type === 'turn/end') {
      const text = this.pending.trim();
      this.pending = '';
      if (text) {
        process.stdout.write('\n\n'); // 回复后两个回车：文本换行 + 空行
        // 长回复（>50 字）不整段播报，只报字数，避免 say 念不完
        if (text.length > 50) {
          this.say(`模型回复了 ${text.length} 个字`);
        } else {
          this.say(text);
        }
      }
      console.log(`[ptt] 📡 turn/end: ${JSON.stringify(evt.data?.reason ?? {}).slice(0, 120)}`);
      const reason = evt.data?.reason;
      if (reason?.kind === 'error') {
        const detail = reason.error ?? reason.failure;
        console.error(`\n[ptt] turn error: ${detail?.message ?? 'unknown'}`);
      }
    }
  }

  /** 语音播报（异步，不阻塞） */
  say(text) {
    if (!this.config.SPEAK_REPLY || this.busy) return;
    // 截断超长文本，避免 say 卡死
    const t = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    this.busy = true;
    const p = spawn('say', ['-v', this.config.VOICE_NAME, t], { stdio: 'ignore' });
    p.on('exit', () => {
      this.busy = false;
    });
  }
}
