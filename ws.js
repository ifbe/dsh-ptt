// ws 输入/输出通道：
//   - text 消息：以 / 开头 = 命令（/stop、/model 等），否则 = 正常对话文本输入
//   - binary 消息：检查是否为 wav（RIFF/WAVE 头）→ 存临时文件 → 走 ASR 流程
//   - OUTPUT_AUDIO=ws 时：播报内容通过 ws 发给客户端（JSON {type:'speak', text}）
import fs from 'node:fs';
import { WebSocketServer } from 'ws';

/**
 * 启动 ws server。
 * @param {object} handlers {onText(text), onWav(wavPath), onSpeak(text)}
 * @param {string} url 如 ws://127.0.0.1:9001（只取 host:port）
 * @param {object} logger
 * @returns {{dispose():void}}
 */
export function startWs({ onText, onWav, onSpeak }, url, logger = console) {
  // cordis logger 没有 .log，统一走包装（兼容 console/cordis）
  const log = (...args) => {
    try {
      (logger?.info ?? logger?.log ?? console.log)(...args);
    } catch {
      console.log(...args);
    }
  };
  if (!url) {
    log('[ptt] ws 未配置 WS_URL，跳过');
    return { dispose() {} };
  }
  // 解析 host:port（ws://127.0.0.1:9001 → 9001）
  let host = '127.0.0.1';
  let port = 9001;
  try {
    const u = new URL(url);
    host = u.hostname || '127.0.0.1';
    port = Number(u.port) || 9001;
  } catch {
    log(`[ptt] ⚠️ WS_URL 解析失败: ${url}，用默认 127.0.0.1:9001`);
  }

  const wss = new WebSocketServer({ host, port });
  log(`[ptt] 🕸️ ws server: ws://${host}:${port}（text=对话/命令，binary=wav 语音）`);

  const send = (ws, obj) => {
    try {
      ws.send(JSON.stringify(obj));
    } catch { /* 客户端断开 */ }
  };

  wss.on('connection', (ws) => {
    log('[ptt] 🕸️ ws 客户端已连接');
    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          // 检查 wav 头：RIFF....WAVE
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
            const wavPath = `/tmp/dsh_ptt_ws.wav`;
            fs.writeFileSync(wavPath, buf);
            log(`[ptt] 🕸️ 收到 wav（${buf.length} 字节）→ ${wavPath}`);
            onWav?.(wavPath);
          } else {
            log(`[ptt] 🕸️ 收到 binary 但非 wav（前 12 字节: ${buf.slice(0, 12).toString('hex')}），忽略`);
          }
        } else {
          const text = data.toString('utf8').trim();
          if (!text) return;
          log(`[ptt] 🕸️ 收到文本: ${text}`);
          onText?.(text);
        }
      } catch (err) {
        log(`[ptt] 🕸️ 处理消息失败: ${err?.message ?? err}`);
      }
    });
    ws.on('close', () => log('[ptt] 🕸️ ws 客户端断开'));
    ws.on('error', (err) => log(`[ptt] 🕸️ ws 错误: ${err?.message}`));
  });
  wss.on('error', (err) => log(`[ptt] 🕸️ ws server 错误: ${err?.message}`));

  // 播报输出：发给所有连接的客户端
  const broadcastSpeak = (text) => {
    for (const client of wss.clients) send(client, { type: 'speak', text });
  };

  return {
    broadcastSpeak,
    dispose() {
      try {
        for (const client of wss.clients) client.close();
        wss.close();
      } catch { /* ignore */ }
    },
  };
}
