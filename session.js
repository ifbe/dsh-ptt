// 会话桥：全部用 DSH 现成机制（agents 服务）——会话/上下文/持久化/LLM 都由 DSH 管。
// 本模块只做四件事：启动时恢复/创建会话、followup 文本、cancel 当前轮、重置会话。
//
// 会话保持（对齐 qqbot）：
//   - sessionId 默认由 SESSION_KEY 确定性派生（sha256）→ 同一 key 永远同一会话
//   - 启动 ensure()：先 agents.resume 恢复（带历史），失败才 agents.create
//   - reset()：切换到全新随机 sessionId 并记录 → 旧会话归档，新会话空白
//   - "当前 sessionId" 记录在 profile 目录的 .ptt-session（ptt 自己的文件，不动 dsh 全局）
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 状态文件：profile 目录（dsh-ptt 的上级）
const STATE_FILE = path.join(HERE, '..', '.ptt-session');

export class SessionBridge {
  /** @param {object} agents ctx.agents @param {object} config @param {object} llm ctx.llm @param {object} ctx */
  constructor(agents, config, llm, ctx) {
    this.agents = agents;
    this.config = config;
    this.llm = llm;
    this.ctx = ctx;
    this.record = null; // {agent, handle}
    this.sessionId = null;
  }

  /** omlx provider 是否已注册（网页端 Models 页管理） */
  hasOmlx() {
    try {
      return this.llm.listProviders().some((p) => p.id === this.config.LLM_PROVIDER);
    } catch {
      return false;
    }
  }

  /** 从 agent 读取实际生效的模型描述（provider/model）
   *  优先 agent.options；其次会话 requestHeader 的 config；
   *  都没有则读 DSH 默认模型（agent-default-model 服务）并显示具体值 */
  modelOf(agent) {
    const opts = agent?.options ?? {};
    if (opts.model) {
      return `${opts.provider ?? '?'}/${opts.model}`;
    }
    try {
      const hdr = agent?.session?.requestHeader?.();
      const cfg = hdr?.config ?? {};
      if (cfg.model) {
        return `${cfg.provider ?? '?'}/${cfg.model}`;
      }
    } catch { /* 忽略 */ }
    try {
      const def = this.ctx.agentDefaultModel?.currentSelection?.();
      if (def?.model) {
        return `${def.provider ?? '?'}/${def.model}`;
      }
    } catch { /* 忽略 */ }
    return '未知';
  }

  /** 默认（主）会话 id：由 SESSION_KEY 确定性派生 */
  defaultSessionId() {
    return createHash('sha256')
      .update(`ptt:${this.config.SESSION_KEY ?? 'ptt-main'}`)
      .digest('hex');
  }

  readStateId() {
    try {
      const v = fs.readFileSync(STATE_FILE, 'utf8').trim();
      return v || null;
    } catch {
      return null;
    }
  }

  writeStateId(id) {
    try {
      fs.writeFileSync(STATE_FILE, id, 'utf8');
    } catch (err) {
      console.error(`[ptt] ⚠️ 会话状态写入失败: ${err?.message}`);
    }
  }

  agentOptions() {
    return {
      provider: this.config.LLM_PROVIDER,
      model: this.config.LLM_MODEL,
    };
  }

  async create(sessionId) {
    // 优先用配置的 omlx provider；omlx 未注册时回退 DSH 默认模型（不传 agentOptions）
    const useOmlx = this.hasOmlx();
    const record = await this.agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      ...(useOmlx ? { agentOptions: this.agentOptions() } : {}),
    });
    console.log(`[ptt] 🆕 创建会话 ${sessionId.slice(0, 12)}…（模型: ${this.modelOf(record.agent)}）`);
    this.record = record;
    this.sessionId = sessionId;
    return record;
  }

  /** 启动/首次：恢复会话（带历史），没有则创建。返回 {agent, handle} */
  async ensure() {
    if (this.record) return this.record;
    const sessionId = this.readStateId() ?? this.defaultSessionId();
    this.sessionId = sessionId;
    // 先试 session-own：不传 agentOptions，看 agent 是否自带模型
    let resumed = null;
    try {
      resumed = await this.agents.resume({ resumeSessionId: sessionId });
    } catch {
      resumed = null; // 会话不存在 → 走 create
    }
    if (resumed) {
      const opts = resumed.agent?.options;
      if (opts?.provider && opts?.model) {
        // 会话自己带模型（session-own）→ 记住之前的选择
        this.record = resumed;
        this.writeStateId(sessionId);
        console.log(`[ptt] ♻️ 恢复会话: ${sessionId.slice(0, 12)}…（模型: ${this.modelOf(resumed.agent)}）`);
        return resumed;
      }
      // DSH resume 不会自动恢复 agentOptions：agent 无模型则销毁，
      // 改用当前配置的模型重新恢复（否则请求报 no provider/model）
      console.log(`[ptt] ♻️ 会话 ${sessionId.slice(0, 12)}… 无自带模型，用当前配置覆盖`);
      await resumed.dispose().catch(() => {});
    }
    try {
      const useOmlx = this.hasOmlx();
      const created = await this.agents.resume({
        resumeSessionId: sessionId,
        ...(useOmlx ? { agentOptions: this.agentOptions() } : {}),
      });
      this.record = created;
      this.writeStateId(sessionId);
      console.log(`[ptt] ♻️ 恢复会话: ${sessionId.slice(0, 12)}…（模型: ${this.modelOf(created.agent)}）`);
      return created;
    } catch {
      // 状态里的会话不可用（不存在/损坏）→ 用全新随机 id 重建，
      // 绝不能拿旧 id 再 create（会覆盖/破坏已有日志）
      const newId = randomUUID();
      const created = await this.create(newId);
      this.writeStateId(newId);
      return created;
    }
  }

  /** 当前会话状态概要（status 命令用） */
  getStatus() {
    const opts = this.record?.agent?.options ?? {};
    const model = this.modelOf(this.record?.agent);
    return {
      sessionId: this.sessionId ? this.sessionId.slice(0, 12) : null,
      model,
      active: !!this.record,
    };
  }

  /** A键语音 → 正常对话 */
  async talk(text) {
    const { agent } = await this.ensure();
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }),
    );
  }

  /** B键语音命令 → 中断当前回复 */
  stop() {
    if (!this.record) return false;
    this.record.agent.cancel({ kind: 'user' });
    return true;
  }

  /** B键语音命令 → 清空上下文：切换到全新会话并记录 */
  async reset() {
    const old = this.record;
    this.record = null;
    if (old) {
      console.log('[ptt] ♻️ 重置：销毁旧会话');
      await old.dispose().catch(() => {});
    }
    const sessionId = randomUUID();
    this.writeStateId(sessionId);
    await this.create(sessionId);
    console.log(`[ptt] 🆕 新会话（重置后）: ${sessionId.slice(0, 12)}…`);
    return true;
  }
}
