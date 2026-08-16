# dsh-ptt — 对讲机式语音输入插件（Walkie-Talkie Voice Input for DSH）

手柄/按键 **按住说话** → 松开自动 ASR（语音转文字）→ 发给 DSH 会话（模型）→ 语音播报回复。
B 键支持**语音命令**（停止/重置/模型/状态/帮助/压缩/目标），全程免打字。

## 功能

- **A 键（按住说话）**：录音 → ASR → 发给 DSH 会话（上下文由 DSH 管理，跨重启恢复）
- **B 键（按住说命令）**：语音命令，不进模型

| 说 | 作用 |
|---|---|
| 停止 / stop | 中断当前回复 |
| 重置 / reset | 清空上下文，开新会话 |
| 模型 / model | 列出所有 provider 及可用模型 |
| 状态 / status | 当前会话信息（id、模型） |
| 帮助 / help | 列出全部命令 |
| 压缩 / compact | 压缩对话历史（DSH 原生） |
| 目标 / goal | 查看当前目标 |

- **长回复**（>50 字）不整段播报，只报字数
- 会话启动时自动恢复（`SESSION_KEY` 决定主会话）

## Python 要求

| 项 | 要求 | 说明 |
|---|---|---|
| Python | **3.12 推荐**（3.10~3.13 均可）| Python 3.14 + pygame 2.6.1 在 macOS 会间歇崩溃（SDL 事件层 bug），勿用 |
| 手柄 | `pygame` | 必须 |
| 录音 | `sounddevice` + `numpy`，**或** `pyaudio` | 二选一；有 pyaudio 优先用 pyaudio（test.py 同款），否则回退 sounddevice（自带 PortAudio，无需系统库）|

```bash
# 一键安装（sounddevice 方案，推荐）
pip install pygame sounddevice numpy

# 或 pyaudio 方案（需系统有 PortAudio：brew install portaudio）
pip install pygame pyaudio
```

## 安装

```bash
# 1. 安装插件（自动创建 ptt profile）
dsh plugin --profile ptt add dsh-ptt

# 2. 安装 Python 依赖（见上方"Python 要求"）

# 3. 启动
dsh --profile ptt
```

## 配置

所有配置在 `~/.dsh/profiles/ptt/cordis.patch.yml`（profile 局部，覆盖插件默认值）：

```yaml
- id: ptt
  config:
    OMLX_BASE_URL: http://macmini.local:12345/v1   # omlx 服务地址
    OMLX_API_KEY: "52755227"                       # ASR 用（LLM 用凭据库同名条目）
    ASR_MODEL: Qwen3-ASR-0.6B-4bit
    LLM_MODEL: Qwen3.6-35B-A3B-4bit
    LLM_PROVIDER: omlx                             # 网页端 Models 页注册的 provider
    SESSION_KEY: ptt-main                          # 改这个 = 换全新主会话
    VOICE_NAME: Ting-Ting                          # macOS 播报语音
    # 手柄、录音、关键词表等见文件内注释
```

### LLM 模型配置（omlx provider，标准流程）

1. 在 DSH 网页端 **Models 页**添加 provider：
   - `apiKeyEnv`: `OMLX_API_KEY`（凭据引用名，可自定）
   - `api` / `baseURL`: 指向你的 OpenAI 兼容服务（如 `http://<host>:12345/v1`）
   - models 列表填入服务支持的模型名
2. 在**密码框**填入 API key（DSH 自动存入凭据库，无需手动改文件）
3. 插件 `LLM_PROVIDER` 填你注册的 provider 名，`LLM_MODEL` 填模型名

> 密钥机制：`apiKeyEnv` 只是凭据库的"条目名"，密钥值在网页端密码框填，存于
> `~/.dsh/.credentials.yaml`。模型配置里不存明文密钥。

## 架构

```
py 层（bridge.py）：pygame 手柄事件 + 录音(pyaudio 优先/sounddevice 回退) → wav
node 层：ASR(omlx) → DSH agents 会话(上下文/LLM/持久化) → 终端打印 + say 播报
```

- 手柄：pygame（SDL dummy video，无窗口），PS4/Xbox 等均可（按钮号可配）
- 会话：DSH 原生 agents 服务（resume 恢复、compact 压缩、goal 目标）
- 录音输出：16bit / 16kHz / 单声道 wav（`/tmp/dsh_ptt_talk.wav`、`dsh_ptt_cmd.wav`）

## 常见问题

- **没反应**：确认手柄已连接且未被其他进程占用（pygame/SDL 单进程独占）；看日志有无 `手柄就绪`
- **录音失败**：macOS 首次使用会请求麦克风权限，到 系统设置→隐私与安全性→麦克风 授权
- **不要同时跑两个 `dsh --profile ptt`**：同一会话并发读写会损坏会话日志
- **按键映射不对**：改 `BUTTON_TALK` / `BUTTON_CMD`（SDL 按钮号）
- **Python 3.14 + pygame 2.6.1 会间歇崩溃**：建议 Python 3.12 + pygame 2.5.2（SDL 2.28）

## License

MIT
