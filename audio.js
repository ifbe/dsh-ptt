// 音频输入源（按 PTT_INPUT_AUDIO 分发）：
//   startGamepad —— 手柄 B/A 键手势事件源（双后端）：
//     1. node-hid（默认）：直接读游戏手柄 HID 报告，绕开 pygame/SDL 事件层
//        （SDL 对 PS4 手柄在 macOS 上有 event.get() 崩溃 bug）
//     2. pygame 桥（兜底）：spawn gamepad.py，逻辑与 ~/test.py 一致
//   startVad —— 纯语音触发（VAD）：spawn vad.py，麦克风 + webrtcvad 状态机
//      检测到语音段 → 录好完整 wav → {"e":"talk_up","wav":"/tmp/..."} 交给 node
// 输出统一语义事件：talk_down/talk_up/cmd_down/cmd_up（gamepad）
//                          talk_down/talk_up/drop（vad）
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';

const require = createRequire(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));

// ────────────────────────── node-hid 后端 ──────────────────────────
// 按钮位在 HID 报告的第 2 字节（report[1]），按位判断（0 未按 / 1 按下）。
// PS4 (DualShock 4)：bit0=X(A 键) bit1=O(B 键)，与 test.py 的 pygame button 0/1 对应。
// 其他手柄若映射不同，改 cordis.patch.yml 的 BUTTON_TALK/BUTTON_CMD 位号即可。
function startNodeHid(handlers, config) {
  let HID;
  try {
    HID = require('node-hid');
  } catch (err) {
    throw new Error(`node-hid 不可用: ${err.message}`);
  }
  const talkBit = Number(config.BUTTON_TALK ?? 0);
  const cmdBit = Number(config.BUTTON_CMD ?? 1);

  let dev;
  let prev = 0;
  let opened = false;
  const DEBOUNCE_MS = 120; // 按下抖动防抖
  const lastDownAt = { talk: 0, cmd: 0 }; // 各按钮独立防抖计时
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const findPad = () => {
    const devs = HID.devices().filter(
      (d) => d.usagePage === 1 && d.usage === 5, // Generic Desktop / Game Pad
    );
    return devs[0] ?? null;
  };

  const openPad = () => {
    const pad = findPad();
    if (!pad) {
      throw new Error('未检测到游戏手柄（node-hid）');
    }
    dev = new HID.HID(pad.path);
    dev.on('data', (buf) => {
      if (!opened) {
        opened = true;
        console.log(`[ptt] 手柄就绪: ${pad.product ?? pad.manufacturer ?? 'gamepad'} (node-hid)`);
        resolveReady?.(pad);
        handlers.onReady?.(pad);
      }
      const btn = buf[1] ?? 0;
      if (btn === prev) return;
      const talkNow = (btn >> talkBit) & 1;
      const cmdNow = (btn >> cmdBit) & 1;
      const talkPrev = (prev >> talkBit) & 1;
      const cmdPrev = (prev >> cmdBit) & 1;
      const now = Date.now();
      if (talkNow && !talkPrev) {
        if (now - lastDownAt.talk > DEBOUNCE_MS) handlers.onTalkDown?.();
        lastDownAt.talk = now;
      } else if (!talkNow && talkPrev) {
        handlers.onTalkUp?.();
      }
      if (cmdNow && !cmdPrev) {
        if (now - lastDownAt.cmd > DEBOUNCE_MS) handlers.onCmdDown?.();
        lastDownAt.cmd = now;
      } else if (!cmdNow && cmdPrev) {
        handlers.onCmdUp?.();
      }
      prev = btn;
    });
    dev.on('error', (err) => rejectReady(err));
  };

  // 启动：立刻尝试打开；失败则等 1.5s 重试（手柄可后接）
  const attempt = () => {
    try {
      openPad();
    } catch {
      console.log('[ptt] 等待手柄接入（node-hid）...');
      setTimeout(attempt, 1500);
    }
  };
  attempt();

  return {
    ready,
    dispose() {
      try {
        dev?.close();
      } catch { /* ignore */ }
    },
  };
}

// ────────────────────────── pygame 桥后端（兜底） ──────────────────────────
function startPyBridge(handlers, config) {
  const pythonBin = config.PYTHON_BIN ?? 'python3';
  const proc = spawn(pythonBin, [
    path.join(here, 'gamepad.py'),
    String(config.BUTTON_TALK ?? 0),
    String(config.BUTTON_CMD ?? 1),
  ], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, PYGAME_HIDE_SUPPORT_PROMPT: '1' },
  });
  const rl = readline.createInterface({ input: proc.stdout });

  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  proc.on('error', (err) => readyReject(err));
  proc.on('exit', (code) => readyReject(new Error(`gamepad bridge exited: ${code}`)));

  rl.on('line', (line) => {
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      console.warn(`[ptt] bad bridge line: ${line}`);
      return;
    }
    switch (evt.e) {
      case 'status':
        if (evt.msg === 'waiting_joystick') {
          console.log('[ptt] 等待手柄接入（pygame）...');
        }
        break;
      case 'ready':
        console.log(`[ptt] 手柄就绪: ${evt.name} (${evt.buttons} buttons)`);
        readyResolve?.(evt);
        handlers.onReady?.(evt);
        break;
      case 'talk_down': handlers.onTalkDown?.(); break;
      case 'talk_up': handlers.onTalkUp?.(evt.wav ?? null); break;
      case 'cmd_down': handlers.onCmdDown?.(); break;
      case 'cmd_up': handlers.onCmdUp?.(evt.wav ?? null); break;
      case 'error':
        console.error(`[ptt] 手柄错误: ${evt.msg}`);
        handlers.onError?.(evt.msg);
        break;
      default:
        console.log(`[ptt] bridge: ${line}`);
    }
  });

  return {
    ready,
    dispose() {
      rl.close();
      proc.kill('SIGTERM');
      // 保险：SDL 可能吞掉 SIGTERM，2 秒后强制结束
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch { /* ignore */ }
      }, 2000).unref?.();
    },
  };
}

// ────────────────────────── 入口 ──────────────────────────
/**
 * @param {object} handlers {onTalkDown,onTalkUp,onCmdDown,onCmdUp,onReady,onError}
 * @param {object} config
 * @returns {{dispose():void, ready: Promise<void>}}
 */
export function startGamepad(handlers, config) {
  const backend = config.GAMEPAD_BACKEND ?? 'node-hid';
  if (backend === 'node-hid') {
    try {
      return startNodeHid(handlers, config);
    } catch (err) {
      console.warn(`[ptt] node-hid 后端不可用，回退 pygame: ${err?.message ?? err}`);
    }
  }
  return startPyBridge(handlers, config);
}

// ────────────────────────── VAD 语音触发（vad.py）──────────────────────────
/**
 * 纯语音触发：spawn vad.py（麦克风 + webrtcvad 状态机）。
 * py 自闭环：采麦克风 → 判语音开始/结束 → 段结束录好完整 wav → emit。
 * node 只被动收事件，控制权全在 py。
 * vad.py 输出 JSON 行：{"e":"status|ready|talk_down|talk_up|drop|error",...}
 * @param {object} handlers {onTalkDown,onTalkUp,onDrop,onReady,onError}
 * @param {object} config
 * @returns {{dispose():void, ready: Promise<void>}}
 */
export function startVad(handlers, config) {
  const pythonBin = config.PYTHON_BIN ?? 'python3';
  const proc = spawn(pythonBin, [path.join(here, 'vad.py')], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  const rl = readline.createInterface({ input: proc.stdout });

  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  proc.on('error', (err) => readyReject(err));
  proc.on('exit', (code) => readyReject(new Error(`vad bridge exited: ${code}`)));

  rl.on('line', (line) => {
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      console.warn(`[ptt] bad vad line: ${line}`);
      return;
    }
    switch (evt.e) {
      case 'status':
        if (evt.msg === 'listening') {
          console.log('[ptt] 🎙️ VAD 监听中（麦克风）...');
          readyResolve?.(evt);
        }
        break;
      case 'ready':
        readyResolve?.(evt);
        handlers.onReady?.(evt);
        break;
      case 'talk_down':
        handlers.onTalkDown?.();
        break;
      case 'talk_up':
        handlers.onTalkUp?.(evt.wav ?? null);
        break;
      case 'drop':
        handlers.onDrop?.(evt);
        break;
      case 'error':
        console.error(`[ptt] VAD 错误: ${evt.msg}`);
        handlers.onError?.(evt.msg);
        break;
      default:
        console.log(`[ptt] vad: ${line}`);
    }
  });

  return {
    ready,
    dispose() {
      rl.close();
      proc.kill('SIGTERM');
      // 保险：声卡线程/循环可能吞掉 SIGTERM，2 秒后强制结束
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch { /* ignore */ }
      }, 2000).unref?.();
    },
  };
}
