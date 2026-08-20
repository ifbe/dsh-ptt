// ws 输入/输出通道：
//   - text 消息：以 / 开头 = 命令（/stop、/model 等），否则 = 正常对话文本输入
//   - binary 消息：检查是否为 wav（RIFF/WAVE 头）→ 存临时文件 → 走 ASR 流程
//   - OUTPUT_AUDIO=ws 时：播报内容通过 ws 发给客户端（JSON {type:'speak', text}）
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
  // 解析 host:port（支持 ws://host:port 或 host:port 两种格式）
  let host = '127.0.0.1';
  let port = 9001;
  try {
    const urlStr = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ? url : `ws://${url}`;
    const u = new URL(urlStr);
    host = u.hostname || '127.0.0.1';
    port = Number(u.port) || 9001;
  } catch {
    log(`[ptt] ⚠️ WS_URL 解析失败: ${url}，用默认 127.0.0.1:9001`);
  }
  // 192 网段：自动匹配本机实际 IP（输入 192.168.5.0 网段地址 → 用本机 192.168.5.x）
  if (host.startsWith('192.')) {
    const ips = [];
    for (const name of Object.keys(os.networkInterfaces())) {
      for (const net of os.networkInterfaces()[name] ?? []) {
        if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
      }
    }
    // 同网段优先（192.168.5.0 → 192.168.5.）
    const prefix = `${host.split('.').slice(0, 3).join('.')}.`;
    const sameNet = ips.find((ip) => ip.startsWith(prefix));
    const any192 = ips.find((ip) => ip.startsWith('192.'));
    const target = sameNet ?? any192;
    if (target && target !== host) {
      log(`[ptt] 🕸️ 192 网段 ${host} → 使用本机 ${target}`);
      host = target;
    } else if (!target) {
      log(`[ptt] ⚠️ 本机没有 192 网段 IP（${ips.join(', ') || '无'}），保持 ${host} 可能绑定失败`);
    }
  }

  // 同一端口：http 服务测试网页 + ws（WebSocket 握手走 Upgrade，互不冲突）
  const server = http.createServer((req, res) => {
    // 根路径 / 也返回测试网页（直接访问 http://host:port 即可）
    const pathname = req.url === '/' ? '/test.html' : req.url;
    if (pathname === '/' || pathname === '/test.html') {
      fs.readFile(path.join(HERE, 'test.html'), (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('test.html not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port, host);
  const wss = new WebSocketServer({ server });
  log(`[ptt] 🕸️ ws+http server: ws://${host}:${port}（text=对话/命令，binary=wav 语音；http://${host}:${port}/test.html）`);

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
  // 文本输出（OUTPUT_TEXT=ws）：模型回复文本（kind: think=思考 / reply=实际回复）
  const broadcastText = (text, kind = 'reply') => {
    for (const client of wss.clients) send(client, { type: 'text', kind, text });
  };
  // 语音 wav 输出（OUTPUT_AUDIO=ws）：直接发二进制 wav 帧（客户端识别为 audio）
  const broadcastAudio = (buf) => {
    for (const client of wss.clients) {
      try {
        client.send(buf, { binary: true });
      } catch { /* 客户端断开 */ }
    }
  };

  return {
    broadcastSpeak,
    broadcastText,
    broadcastAudio,
    dispose() {
      try {
        for (const client of wss.clients) client.close();
        wss.close();
        server.close();
      } catch { /* ignore */ }
    },
  };
}
