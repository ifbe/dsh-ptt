// 会话桥：全部用 DSH 现成机制（agents 服务）——会话/上下文/持久化/LLM 都由 DSH 管。
// 本模块只做四件事：启动时恢复/创建会话、followup 文本、cancel 当前轮、重置会话。
//
// 会话保持（对齐 qqbot）：
//   - sessionId 默认由 SESSION_KEY 确定性派生（sha256）→ 同一 key 永远同一会话
//   - 启动 ensure()：先 agents.resume 恢复（带历史），失败才 agents.create
//   - reset()：切换到全新随机 sessionId 并记录 → 旧会话归档，新会话空白
//   - "当前 sessionId" 记录在 profile 目录的 .ptt-session（ptt 自己的文件，不动 dsh 全局）
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserMessage, contentHasImage } from '@deepseek-ai/dsh-llm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 状态文件：profile 目录（dsh-ptt 的上级）
const STATE_FILE = path.join(HERE, '..', '.ptt-session');

/**
 * 检测同一 profile 内装了哪个聊天软件（IM）插件。
 * 读 profile 的 package.json（dsh-ptt 的上级目录），检查 bundles/dependencies
 * 里是否有 IM 插件包名。
 * @param {object} ctx
 * @returns {'qqbot'|'feishu'|'wechat'|null} 插件类型；null = 无（独立模式）
 */
export function detectImPlugin(ctx) {
  // IM 插件包名 → 类型（飞书/微信装好后补充包名）
  const IM_PACKAGES = {
    '@tencent-connect/dsh-qqbot': 'qqbot',
  };
  try {
    const profilePkg = JSON.parse(
      fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'),
    );
    const bundles = profilePkg.dsh?.profile?.bundles ?? [];
    const depNames = Object.keys(profilePkg.dependencies ?? {});
    for (const name of [...bundles, ...depNames]) {
      if (IM_PACKAGES[name]) return IM_PACKAGES[name];
    }
  } catch { /* 读不到或解析失败 → 视为无 IM */ }
  return null;
}

/**
 * 从持久化会话里匹配 IM（QQ）会话：
 * 排除 ptt 自己的会话（SESSION_KEY 派生 + .ptt-session 记录的），
 * 剩下的取最近创建的（用户场景只有一个 QQ 会话）。
 * @param {object} ctx
 * @param {string} pttSessionId ptt 主会话 id（用于排除）
 * @param {string|null} pttStateId ptt 状态文件记录的会话 id（用于排除）
 * @returns {Promise<{sessionId: string, createdAt: number}|null>}
 */
export async function matchImSession(ctx, pttSessionId, pttStateId) {
  try {
    const sessions = await ctx.sessionPersistence.list();
    const others = sessions
      .filter((s) => s.id !== pttSessionId && s.id !== pttStateId)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const latest = others[0];
    return latest ? { sessionId: latest.id, createdAt: latest.createdAt ?? 0 } : null;
  } catch { /* 枚举失败 → 无会话 */ }
  return null;
}

/** 时间戳 → 可读时间（去掉 created= 前缀，直接显示） */
function fmtTime(ts) {
  if (!ts) return '?';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 从会话日志文件提取 {model, title, empty}（zstd 解压，只读一遍） */
function sessionFacts(logPath) {
  const facts = { model: '?', title: '', empty: true };
  try {
    const out = execFileSync('zstd', ['-dc', logPath], { maxBuffer: 32 * 1024 * 1024 });
    const text = out.toString('utf8');
    const lines = text.split('\n');
    // empty：是否没有任何用户消息（source.kind=user 的 user/message）
    facts.empty = !lines.some(
      (l) => l.includes('"user/message"') && l.includes('"kind":"user"'),
    );
    // model：最后一个 request/header 的 config
    const headers = lines.filter((l) => l.includes('"request/header"'));
    const m = headers[headers.length - 1]?.match(/"config":\{"provider":"([^"]*)","model":"([^"]*)"/);
    if (m) facts.model = `${m[1]}/${m[2]}`;
    // title：最后一个 session/title 事件
    const titles = lines.filter((l) => l.includes('"type":"session/title"'));
    const tm = titles[titles.length - 1]?.match(/"title":"([^"]*)"/);
    if (tm) facts.title = tm[1];
  } catch { /* 读不到 → 默认 */ }
  return facts;
}

/** 完整格式（全部会话用）：uuid/time/model/dir/subagent/archived/empty/title */
function describeSessionFull(a, archived) {
  const h = a.header ?? a;
  const f = a.path ? sessionFacts(a.path) : { model: '?', title: '', empty: true };
  const subagent = h.origin === 'subagent' || (h.delegationDepth ?? 0) > 0;
  return `uuid=${h.id} time=${fmtTime(h.createdAt)} model=${f.model} dir=${h.cwd ?? ''} subagent=${subagent ? 'true' : 'false'} archived=${archived ? 'true' : 'false'} empty=${f.empty ? 'true' : 'false'} title=${f.title}`;
}

/** 简洁格式（排序列表用）：uuid/time/model/dir/title */
function describeSessionSimple(a) {
  const h = a.header ?? a;
  const f = a.path ? sessionFacts(a.path) : { model: '?', title: '' };
  return `uuid=${h.id} time=${fmtTime(h.createdAt)} model=${f.model} dir=${h.cwd ?? ''} title=${f.title}`;
}

/** 会话是否空白（无用户消息） */
function isEmptySession(a) {
  const h = a.header ?? a;
  return a.path ? sessionFacts(a.path).empty : true;
}

/** 是否子代理会话 */
function isSubagent(a) {
  const h = a.header ?? a;
  return h.origin === 'subagent' || (h.delegationDepth ?? 0) > 0;
}

/**
 * 启动时会话管理（按用户伪代码）：
 *   1. 日志打印所有会话
 *   2. 排序后再打印
 *   3. 分支：qqbot 存在 → 尝试匹配 QQ 会话；
 *           飞书/微信存在 → 当前无行为（绑定未实现）；
 *           都没有 → 独立模式
 * @param {object} ctx
 * @param {SessionBridge} bridge
 * @returns {Promise<{mode:'assist'|'standalone', imSession:object|null}>}
 */
export async function manageSessions(ctx, bridge) {
  let artifacts = [];
  try {
    artifacts = await ctx.sessionPersistence.listArtifacts();
  } catch (err) {
    console.warn(`[ptt] ⚠️ 枚举会话失败: ${err?.message ?? err}`);
  }
  // 归档会话：读 DSH 全局 workspace.json（ptt profile 无 workspaceRegistry 服务）
  let archivedSet = new Set();
  try {
    const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
    const ws = JSON.parse(fs.readFileSync(path.join(dshHome, 'storages', 'workspace.json'), 'utf8'));
    archivedSet = new Set(ws.global?.archivedSessionIds ?? []);
  } catch { /* 读不到 → 全部未归档 */ }

  // 1) 打印所有会话（完整格式）
  console.log(`[ptt] 📋 全部会话（${artifacts.length} 个）:`);
  for (const a of artifacts) console.log('   ' + describeSessionFull(a, archivedSet.has(a.header.id)));

  // 2) 排序（按创建时间倒序）后打印：过滤归档 + 子代理 + 空白会话
  const active = artifacts.filter(
    (a) => !archivedSet.has(a.header.id) && !isSubagent(a) && !isEmptySession(a),
  );
  const sorted = [...active].sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0));
  console.log(`[ptt] 📋 可用会话（按创建时间倒序，${sorted.length} 个）:`);
  for (const a of sorted) console.log('   ' + describeSessionSimple(a));

  // 3) 模式分支
  const im = detectImPlugin(ctx);
  if (im === 'qqbot') {
    console.log('[ptt] 🎙️ 检测到 qqbot 插件，尝试匹配 QQ 会话...');
    const pttId = bridge.defaultSessionId();
    const pttState = bridge.readStateId();
    const qq = await matchImSession(ctx, pttId, pttState);
    if (qq) {
      bridge.bindImSession(qq);
      console.log(`[ptt] 🎙️ 辅助模式：匹配到 QQ 会话 ${qq.sessionId.slice(0, 12)}…（不创建 ptt 会话）`);
      return { mode: 'assist', imSession: qq };
    }
    console.log('[ptt] 🎙️ 辅助模式：未找到 QQ 会话（语音将提示"会话不存在"）');
    return { mode: 'assist', imSession: null };
  }
  if (im === 'feishu' || im === 'wechat') {
    console.log(`[ptt] 🎙️ 检测到 ${im} 插件：绑定未实现，当前无行为`);
    return { mode: 'assist', imSession: null };
  }
  console.log('[ptt] 🎙️ 独立模式：无聊天软件插件，使用 ptt 自己的会话');
  return { mode: 'standalone', imSession: null };
}

export class SessionBridge {
  /**
   * @param {object} agents ctx.agents
   * @param {object} config
   * @param {object} llm ctx.llm
   * @param {object} ctx
   * @param {boolean} hasIm 同 profile 是否装了聊天软件插件（true=辅助模式，false=独立模式）
   */
  constructor(agents, config, llm, ctx, hasIm = false) {
    this.agents = agents;
    this.config = config;
    this.llm = llm;
    this.ctx = ctx;
    this.hasIm = hasIm; // 有 IM 插件 = 辅助模式（不创建 ptt 会话）
    this.record = null; // {agent, handle}（独立模式用）
    this.sessionId = null; // 独立模式的会话 id
    this.imSession = null; // 辅助模式当前绑定的 IM 会话（可能为 null=无会话）
  }

  /** 是否辅助模式（装了 IM 插件即辅助，会话可有可无） */
  get isAssist() {
    return this.hasIm;
  }

  /** 绑定 IM 会话（辅助模式）：设置模式 + 会话 */
  bindImSession(session) {
    this.hasIm = true;
    this.imSession = session;
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
    // 辅助模式：不创建/恢复 ptt 会话，实时找 IM 会话；无会话返回 null
    if (this.isAssist) {
      const im = this.findImSession();
      this.imSession = im;
      return im ? { agent: im.agent } : null;
    }
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
    if (this.isAssist) {
      const im = this.findImSession();
      return {
        mode: 'assist',
        sessionId: im ? im.sessionId.slice(0, 12) : null,
        model: im ? this.modelOf(im.agent) : null,
        active: !!im,
      };
    }
    return {
      mode: 'standalone',
      sessionId: this.sessionId ? this.sessionId.slice(0, 12) : null,
      model: this.modelOf(this.record?.agent),
      active: !!this.record,
    };
  }

  /**
   * A键语音 → 正常对话。
   * 返回 {ok:true} 已发送；{noSession:true} 辅助模式且无 IM 会话（调用方播报提示）。
   */
  async talk(text) {
    const rec = await this.ensure();
    if (!rec) return { noSession: true };
    rec.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }),
    );
    return { ok: true };
  }

  /**
   * 通用：发送一组内容块（text/image 等）给模型。
   * 图片块需已用附件服务保存为 ImageAttachmentRef。
   * 返回 {ok:true} 已发送；{noSession:true} 无会话。
   */
  async talkUserContent(blocks) {
    const rec = await this.ensure();
    if (!rec) return { noSession: true };
    rec.agent.followup(
      createUserMessage({
        content: blocks,
        source: { kind: 'user' },
      }),
    );
    return { ok: true };
  }

  /**
   * 切换当前会话的模型（provider/model）。校验通过后用一个新 agent 重新
   * 挂到同一会话（agentOptions 覆盖模型），并让后续 ensure/resume 沿用。
   * 返回 {ok:true, model}；{noSession:true}；{fail:原因}；校验失败 throw。
   */
  async switchModel(provider, model) {
    if (this.isAssist) return { fail: '辅助模式（聊天软件会话）不由 ptt 切换模型' };
    // 校验 route（未知 provider/model 会抛错）→ 给调用方做失败处理
    const resolved = await this.llm.resolveCallConfig({ provider, model });
    const rec = await this.ensure();
    if (!rec) return { noSession: true };
    // 回合进行中不切换（对齐 tui：/model 在 working 时被拒）
    if (rec.agent?.status === 'running') {
      return { fail: '当前回合进行中，先停止/等完成再切换模型' };
    }
    // 会话已含图片时，要求新模型支持 image
    const msgs = rec.agent?.session?.deriveMessages?.() ?? [];
    if (msgs.some((m) => contentHasImage(m.content))) {
      const info = typeof this.llm.resolveModelInfo === 'function'
        ? await this.llm.resolveModelInfo(resolved.provider, resolved.model)
        : undefined;
      if (info?.inputModalities && !info.inputModalities.includes('image')) {
        return { fail: `当前会话已含图片，但 ${resolved.model} 不支持 image` };
      }
    }
    // 用新模型重新挂到同一会话（保留历史），替换当前 agent 句柄
    const sessionId = this.sessionId;
    if (this.record) await this.record.dispose().catch(() => {});
    const resumed = await this.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: resolved.provider, model: resolved.model },
    });
    this.record = resumed;
    // 让后续 ensure()/agentOptions() 也沿用新模型
    this.config.LLM_PROVIDER = resolved.provider;
    this.config.LLM_MODEL = resolved.model;
    return { ok: true, model: `${resolved.provider}/${resolved.model}` };
  }

  /**
   * 切换当前会话的工作目录（cwd）。会话的 cwd 写在不可变的 header 里、
   * resume 也沿用原 cwd，所以只能 fork 会话（保留历史）+ 新 cwd 重建 agent。
   * 返回 {ok:true, cwd}；{noSession:true}；{fail:原因}；路径校验失败也走 fail。
   */
  async switchWorkspace(path) {
    if (this.isAssist) return { fail: '辅助模式（聊天软件会话）不由 ptt 切换工作目录' };
    // 校验目录存在且是目录
    let stat;
    try {
      stat = fs.statSync(path);
    } catch {
      return { fail: `路径不存在或不可访问: ${path}` };
    }
    if (!stat.isDirectory()) return { fail: `路径不是目录: ${path}` };
    const rec = await this.ensure();
    if (!rec) return { noSession: true };
    if (rec.agent?.status === 'running') return { fail: '当前回合进行中，先停止/等完成再切换' };
    const sessions = this.ctx.get('sessions');
    if (!sessions) return { fail: '会话服务不可用' };
    // fork 当前会话 → 提取事件当 seed（保留历史）
    let seed;
    try {
      seed = sessions.fork(rec.agent.session).events;
    } catch (err) {
      return { fail: `会话 fork 失败: ${err?.message ?? err}` };
    }
    const before = rec.agent.session.header.cwd ?? process.cwd();
    const newId = randomUUID();
    if (this.record) await this.record.dispose().catch(() => {});
    const record = await this.agents.create({
      sessionId: newId,
      seed,
      meta: {
        cwd: path,
        parentSession: rec.agent.session.id,
        seedLength: seed.length,
      },
      agentOptions: this.agentOptions(),
    });
    this.record = record;
    this.sessionId = newId;
    this.writeStateId(newId);
    return { ok: true, cwd: path, before };
  }

  /** B键语音命令 → 中断当前回复 */
  stop() {
    if (this.isAssist) {
      const im = this.findImSession();
      if (!im) return false;
      im.agent.cancel({ kind: 'user' });
      return true;
    }
    if (!this.record) return false;
    this.record.agent.cancel({ kind: 'user' });
    return true;
  }

  /** B键语音命令 → 清空上下文：切换到全新会话并记录 */
  async reset() {
    if (this.isAssist) {
      // 辅助模式：不重置 IM 会话（QQ 会话生命周期由 IM 插件管），返回 false 由调用方提示
      return false;
    }
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
