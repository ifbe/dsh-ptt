#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# VAD 触发（py 自闭环）：麦克风 → webrtcvad 状态机 → 语音段结束 → 录好完整 wav → emit
# 交给 node（audio.js 的 startVad）。node 只被动收事件，控制权全在这里。
#   本脚本只做「采集→判语音段→写 wav」，不调 ASR/模型（ASR 在 node 层做）。
# stdout 输出 JSON 行（node 逐行解析）：
#   {"e":"status","msg":"listening"}      麦克风已开，开始监听
#   {"e":"talk_down"}                     检测到说话开始
#   {"e":"talk_up","wav":"/tmp/...wav"}   说话结束，wav 已写好（≥ MIN_DURATION_MS）
#   {"e":"drop","reason":"too_short","duration_ms":N}  段太短，丢弃
#   {"e":"error","msg":"..."}             出错
# 依赖：sounddevice、webrtcvad（用户自行安装）
import json
import queue
import sys
import types
import wave


def _die(msg):
    """依赖缺失时打印清晰诊断（含当前 python），并退出。"""
    print(msg, file=sys.stderr)
    print(f"  使用的 python: {sys.executable}", file=sys.stderr)
    print(f"  python 版本: {sys.version.split()[0]} ({sys.platform})", file=sys.stderr)
    sp = [p for p in sys.path if "site-packages" in p or "dist-packages" in p]
    print(f"  site-packages 搜索路径: {sp or sys.path[:3]}", file=sys.stderr)
    print(f"  安装到当前 python 请用: {sys.executable} -m pip install webrtcvad", file=sys.stderr)
    sys.exit(1)


# ── 兼容 shim：webrtcvad 2.0.10 顶部 `import pkg_resources` 只为取版本号，
#    而 setuptools>=81 已移除 pkg_resources，导致导入失败（原生 _webrtcvad 在即可）。
#    这里给个最小替身，让 webrtcvad 能正常 import。
try:
    import pkg_resources  # noqa: F401
except ModuleNotFoundError:
    pkg_resources = types.ModuleType('pkg_resources')
    pkg_resources.get_distribution = lambda name: types.SimpleNamespace(version='2.0.10')
    sys.modules['pkg_resources'] = pkg_resources

try:
    import numpy as np
    import sounddevice as sd
except ImportError as e:
    _die(f"❌ 缺少第三方库 sounddevice/numpy：{e}")

try:
    import webrtcvad
except ImportError as e:
    _die(f"❌ 缺少 webrtcvad：{e}")

# ==================== 配置区（改这试验）====================
SAMPLE_RATE = 16000        # 采样率（ASR 友好，勿改）
CHANNELS = 1               # 单声道
BLOCK_DURATION_MS = 20     # 底层帧长：webrtcvad 只支持 10/20/30ms（16k 下 20ms=320 样本）
BLOCK_SIZE = int(SAMPLE_RATE * BLOCK_DURATION_MS / 1000)  # 320
VAD_LEVEL = 2              # webrtcvad.Vad(0-3)，越大越严格（2 常用）
START_THRESHOLD_FRAMES = 8  # 连续 N 帧有声音 → 认为开始说话（8×20ms=160ms）
END_THRESHOLD_FRAMES = 25   # 连续 N 帧无声音 → 认为说话结束（25×20ms=500ms，容纳句内停顿）
MIN_DURATION_MS = 600       # 低于此长度的语音段丢弃（防杂音误发）
MAX_DURATION_MS = 60000     # 超过强制结束（防异常长段撑爆内存/误发），默认 60s
OUT_WAV = "/tmp/dsh_ptt_vad.wav"  # 语音段输出 wav（每次覆盖，不堆积）
# ==========================================================


def emit(event, **extra):
    print(json.dumps({"e": event, **extra}, ensure_ascii=False), flush=True)


def main():
    vad = webrtcvad.Vad(VAD_LEVEL)
    audio_queue = queue.Queue()

    def audio_callback(indata, frames, time_info, status):
        if status:
            emit("error", msg=f"音频状态警告: {status}")
        audio_queue.put(indata.copy())

    state = "IDLE"            # IDLE=待机 / SPEAKING=说话中
    audio_buffer = []
    consecutive_speech = 0
    consecutive_silence = 0
    speech_start_frame = 0
    frame_counter = 0

    try:
        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            blocksize=BLOCK_SIZE,
            dtype="int16",
            callback=audio_callback,
        ):
            emit("status", msg="listening")
            while True:
                audio_block = audio_queue.get()
                audio_bytes = audio_block.tobytes()
                # webrtcvad 要求 10/20/30ms 帧；len 正好 BLOCK_SIZE*2 即 20ms int16
                if len(audio_bytes) != BLOCK_SIZE * 2:
                    continue
                try:
                    is_speech = vad.is_speech(audio_bytes, sample_rate=SAMPLE_RATE)
                except Exception as e:
                    emit("error", msg=f"VAD 帧异常: {e}")
                    continue
                frame_counter += 1

                # ── IDLE：连续有声音 → 开始 ──
                if state == "IDLE":
                    if is_speech:
                        consecutive_speech += 1
                        if consecutive_speech >= START_THRESHOLD_FRAMES:
                            state = "SPEAKING"
                            speech_start_frame = frame_counter
                            consecutive_silence = 0
                            audio_buffer = [audio_block.copy()]
                            emit("talk_down")
                    else:
                        consecutive_speech = 0

                # ── SPEAKING：累积；连续静音 → 结束 ──
                elif state == "SPEAKING":
                    audio_buffer.append(audio_block.copy())
                    if is_speech:
                        consecutive_silence = 0
                    else:
                        consecutive_silence += 1

                    duration_ms = (frame_counter - speech_start_frame) * BLOCK_DURATION_MS
                    if consecutive_silence >= END_THRESHOLD_FRAMES or duration_ms >= MAX_DURATION_MS:
                        state = "IDLE"
                        consecutive_speech = 0
                        consecutive_silence = 0
                        if duration_ms < MIN_DURATION_MS:
                            emit("drop", reason="too_short", duration_ms=duration_ms)
                        else:
                            data = np.concatenate(audio_buffer) if len(audio_buffer) > 1 else audio_buffer[0]
                            with wave.open(OUT_WAV, "wb") as wf:
                                wf.setnchannels(CHANNELS)
                                wf.setsampwidth(2)  # int16
                                wf.setframerate(SAMPLE_RATE)
                                wf.writeframes(data.tobytes())
                            emit("talk_up", wav=OUT_WAV)
                        audio_buffer = []
    except KeyboardInterrupt:
        emit("status", msg="stopped")
    except Exception as e:
        emit("error", msg=str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
