#!/usr/bin/env python3
"""
手柄桥（py 层）：pygame 手柄事件 + 录音生成 wav，输出 JSON 行给 node。
node 层负责 ASR/会话/LLM（本脚本只管 手柄→录音→wav）。

录音后端：优先 pyaudio（test.py 同款逻辑），没有 pyaudio 时回退 sounddevice。

事件协议（stdout JSON）：
  {"e":"status","msg":"waiting_joystick"}
  {"e":"ready","name":...,"buttons":N}
  {"e":"talk_down"}                      A 按下 → 开始录音
  {"e":"talk_up","wav":"/tmp/..."}        A 松开 → 停止录音 → wav 路径
  {"e":"cmd_down"}                       B 按下 → 开始录音
  {"e":"cmd_up","wav":"/tmp/..."}        B 松开 → 停止录音 → wav 路径
  {"e":"error","msg":...}

实现说明：
- pygame：SDL dummy video（无窗口），事件队列驱动按钮
- 录音：优先 pyaudio（线程采集），回退 sounddevice（流回调）
- 输出：16bit / 16kHz / 单声道 wav
"""
import json
import os
import signal
import sys
import time

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

import pygame

# ── 录音后端检测：优先 pyaudio，回退 sounddevice ──
try:
    import pyaudio
    import threading
    import wave
    USE_PYAUDIO = True
except ImportError:
    import numpy as np
    import sounddevice as sd
    import wave
    USE_PYAUDIO = False

# A/B 按钮号由 dsh-ptt 配置传入（cordis.patch.yml 的 BUTTON_TALK/BUTTON_CMD）
BUTTON_TALK = int(sys.argv[1]) if len(sys.argv) > 1 else 0
BUTTON_CMD = int(sys.argv[2]) if len(sys.argv) > 2 else 1

# 录音参数（16bit/16kHz/单声道，ASR 友好）
CHANNELS = 1
RATE = 16000
CHUNK = 1024  # pyaudio 块
CHUNK_SECONDS = 0.05  # sounddevice 块时长

# 输出 wav（A/B 分开，便于排查；不自动删除，下次录音覆盖）
OUT_WAV_TALK = "/tmp/dsh_ptt_talk.wav"
OUT_WAV_CMD = "/tmp/dsh_ptt_cmd.wav"


def emit(event: str, **extra):
    print(json.dumps({"e": event, **extra}, ensure_ascii=False), flush=True)


def on_term(sig, frame):
    sys.exit(0)


# ────────────────────────── pyaudio 录音器（优先）──────────────────────────
class PyaudioRecorder:
    """test.py 同款：线程采集，16bit/16k/单声道"""

    def __init__(self):
        self.p = pyaudio.PyAudio()
        self.is_recording = False
        self.audio_data = []
        self.thread = None

    def start(self):
        if self.is_recording:
            return
        self.is_recording = True
        self.audio_data = []
        self.thread = threading.Thread(target=self._record)
        self.thread.start()

    def _record(self):
        stream = self.p.open(
            format=pyaudio.paInt16, channels=CHANNELS, rate=RATE,
            input=True, frames_per_buffer=CHUNK,
        )
        while self.is_recording:
            data = stream.read(CHUNK, exception_on_overflow=False)
            self.audio_data.append(data)
        stream.stop_stream()
        stream.close()

    def stop(self, out_wav):
        if not self.is_recording:
            return None
        self.is_recording = False
        if self.thread:
            self.thread.join()
        if not self.audio_data:
            return None
        wav = wave.open(out_wav, "wb")
        wav.setnchannels(CHANNELS)
        wav.setsampwidth(self.p.get_sample_size(pyaudio.paInt16))
        wav.setframerate(RATE)
        wav.writeframes(b"".join(self.audio_data))
        wav.close()
        return out_wav

    def terminate(self):
        self.p.terminate()


# ────────────────────────── sounddevice 录音器（回退）──────────────────────────
class SounddeviceRecorder:
    """流回调采集（自带 PortAudio，无需 brew 装 pyaudio 时用）"""

    def __init__(self):
        self.stream = None
        self.audio = []

    def _cb(self, indata, frames, t, status):
        self.audio.append(indata.copy())

    def start(self):
        if self.stream:
            return
        self.audio = []
        self.stream = sd.InputStream(
            samplerate=RATE, channels=CHANNELS, dtype="int16",
            blocksize=int(RATE * CHUNK_SECONDS), callback=self._cb,
        )
        self.stream.start()

    def stop(self, out_wav):
        if not self.stream:
            return None
        self.stream.stop()
        self.stream.close()
        self.stream = None
        if not self.audio:
            return None
        data = np.concatenate(self.audio) if len(self.audio) > 1 else self.audio[0]
        wav = wave.open(out_wav, "wb")
        wav.setnchannels(CHANNELS)
        wav.setsampwidth(2)  # int16
        wav.setframerate(RATE)
        wav.writeframes(data.tobytes())
        wav.close()
        return out_wav

    def terminate(self):
        pass


def make_recorder():
    if USE_PYAUDIO:
        emit("status", msg=f"recorder: pyaudio")
        return PyaudioRecorder()
    emit("status", msg=f"recorder: sounddevice")
    return SounddeviceRecorder()


def main():
    signal.signal(signal.SIGTERM, on_term)
    # dummy video：display.init() 离线初始化，让事件队列可用且不弹窗口
    pygame.display.init()
    pygame.joystick.init()
    recorder = make_recorder()
    emit("status", msg="waiting_joystick")
    try:
        while True:
            if pygame.joystick.get_count() == 0:
                emit("status", msg="waiting_joystick")
                time.sleep(1.5)
                continue
            js = pygame.joystick.Joystick(0)
            js.init()
            emit("ready", name=js.get_name(), buttons=js.get_numbuttons())
            while pygame.joystick.get_count() > 0:
                try:
                    for event in pygame.event.get():
                        if event.type == pygame.JOYBUTTONDOWN:
                            if event.button == BUTTON_TALK:
                                emit("talk_down")
                                recorder.start()
                            elif event.button == BUTTON_CMD:
                                emit("cmd_down")
                                recorder.start()
                        elif event.type == pygame.JOYBUTTONUP:
                            if event.button == BUTTON_TALK:
                                wav = recorder.stop(OUT_WAV_TALK)
                                emit("talk_up", wav=wav)
                            elif event.button == BUTTON_CMD:
                                wav = recorder.stop(OUT_WAV_CMD)
                                emit("cmd_up", wav=wav)
                except Exception as ex:
                    # SDL 偶发崩溃：重启 SDL 后继续
                    emit("status", msg=f"event_error: {ex}")
                    pygame.quit()
                    pygame.display.init()
                    pygame.joystick.init()
                time.sleep(0.01)
            emit("status", msg="joystick_lost")
    except KeyboardInterrupt:
        pass
    finally:
        recorder.terminate()
        pygame.quit()
    return 0


if __name__ == "__main__":
    sys.exit(main())
