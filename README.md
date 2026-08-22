# dsh-ptt — 多功能对讲机式语音输入插件（DSH）

一个插件，**三种可选工作模式**，通过 `PTT_*` 环境变量切换/组合。

## 功能1：手柄对讲机

**手柄A键按住说话** → 录音 → ASR → 发给 DSH 会话（模型）→ 语音播报回复
**B键按住说命令**
**需要：Python 手柄驱动（`pygame` + `sounddevice`/`pyaudio`）＋ 手柄**
```bash
dsh --profile ptt
```

## 功能2：ws 对讲机（带 Web 界面）

纯 ws 双向通道（文本 / 命令 / 图片 / wav），并附带一个**浏览器测试页**。无需手柄/麦克风权限。

浏览器打开 web 界面后：文本框发文字/命令；点「选择文件」或拖入文件，**可同时上传图片和 wav**——图片走视觉识别（需 `PTT_INPUT_IMAGE=ws`），wav 走语音输入（需 `PTT_INPUT_AUDIO=ws`）。

```bash
#全走 ws（网页播报）
PTT_INPUT_TEXT=ws \
PTT_INPUT_AUDIO=ws \
PTT_INPUT_IMAGE=ws \
PTT_OUTPUT_TEXT=ws \
PTT_OUTPUT_AUDIO=ws \
PTT_WS_URL=ws://0.0.0.0:9001 \
dsh --profile ptt
```

> `PTT_WS_URL` 决定 ws 服务端口，web 界面地址 = `http://<host>:<port>/`。`0.0.0.0` 表示监听所有网卡（局域网其它机器可连）；只用本机可换成 `127.0.0.1`。

## 功能3：纯终端对讲机

只用终端：**stdin 输入、stdout 输出**，其它 in/out（音频、图片、ws）**全部关闭**。无需手柄、无需 web、无语音。

```bash
# 关闭音频/图片输入，关闭语音输出 → 只剩 stdin 文字输入 + stdout 文本回复
PTT_INPUT_AUDIO=none \
PTT_OUTPUT_AUDIO=none \
dsh --profile ptt
```

> 启动后在终端输入一行回车即发给模型，回复打印在 stdout。`PTT_INPUT_TEXT=stdin`、`PTT_OUTPUT_TEXT=stdout` 是默认值，可省略。

## 可选组合

音频、文本、图片、输出**四条通道各自独立**，由 `PTT_*` 环境变量开关（下表），可按需组合或禁用。例如：手柄说话 → ws 输出；ws 发图片+文字；纯 ws 无手柄等。

## 命令

| 命令 | 作用 |
|---|---|
| `/stop` | 中断当前回复 |
| `/reset` | 清空上下文，开新会话 |
| `/status` | 当前会话信息（模式/会话/模型） |
| `/model` | 列出模型+当前；`/model <provider/model>` 切换 |
| `/permission` | 列出权限+当前；`/permission <name>` 切换 |
| `/fork` | 显示当前目录；`/fork <路径>` 切换工作目录 |
| `/workspace` | 列出当前目录（切换路径请用 `/fork`） |
| `/compact` / `/goal` | 压缩历史 / 查看目标（DSH 原生） |
| `/help` | 全部命令 |

## 环境变量（重点）

运行前用 `PTT_*` 环境变量配置，**优先于** `cordis.patch.yml`（未设则用插件默认）。

| 变量 | 可选值 | 默认 | 说明 |
|---|---|---|---|
| `PTT_INPUT_AUDIO` | gamepad / mic / ws / none | gamepad | 音频来源（功能1=gamepad，功能2=ws，功能3=none） |
| `PTT_INPUT_TEXT` | stdin / ws / none | stdin | 文本来源 |
| `PTT_INPUT_IMAGE` | ws / none | none | ws 图片输入（与音频独立） |
| `PTT_OUTPUT_TEXT` | stdout / ws / none | stdout | 文本输出 |
| `PTT_OUTPUT_AUDIO` | say / ws / none / auto | auto | 语音输出（auto=macOS 有 say 才 say，否则 none） |
| `PTT_MODEL` | provider/model | 空 | 覆盖 LLM 模型 |
| `PTT_WS_URL` | ws://host:port | 空 | ws 地址（音频/文字走 ws 时必填，兼作 web 界面） |
| `PTT_TTS` | say / none | say | 语音合成 |
| `PTT_ASR` | openai / none | openai | ASR 方式 |
| `PTT_ASR_URL` | url | OMLX_BASE_URL | ASR 端点 |
| `PTT_ASR_API` | transcribe | transcribe | ASR 接口路径 |
| `PTT_ASR_KEY` | key | OMLX_API_KEY | ASR key |
| `PTT_ASR_MODEL` | model | ASR_MODEL | ASR 模型名 |

## 安装

```bash
dsh plugin --profile ptt add dsh-ptt     # 自动创建 ptt profile
dsh --profile ptt
```

- **功能1（手柄）**还需 Python 依赖：`pip install pygame sounddevice numpy`（或 `pyaudio`）。推荐 Python **3.12**（3.10~3.13 均可；勿用 3.14 + pygame 2.6.1，会间歇崩溃）
- LLM/ASR 模型通过 `settings.yaml` 的 `llm-pi-ai.providers.omlx` 配置，插件在 `cordis.patch.yml` 指定 `LLM_PROVIDER`/`LLM_MODEL`

## License

MIT
