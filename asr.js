// ASR：wav → 文字，走 omlx 的 OpenAI 兼容 /v1/audio/transcriptions（协议与 ~/test.py 一致）
import fs from 'node:fs';

/**
 * @param {string} wavPath
 * @param {object} config
 * @returns {Promise<string>} 识别文本（可能为空串）
 */
export async function transcribe(wavPath, config) {
  const buf = fs.readFileSync(wavPath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'rec.wav');
  form.append('model', config.ASR_MODEL);
  form.append('stream', 'true');

  const res = await fetch(`${config.OMLX_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.OMLX_API_KEY ?? process.env.OMLX_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    throw new Error(`ASR HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  let full = '';
  if (contentType.includes('text/event-stream')) {
    // SSE：每行 data: {...}，text=全量 / delta=增量，与 test.py 解析逻辑一致
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf2 = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf2 += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf2.indexOf('\n')) >= 0) {
        const line = buf2.slice(0, idx).trim();
        buf2 = buf2.slice(idx + 1);
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const obj = JSON.parse(data);
          // omlx 流式格式：delta 是增量（拼接）；text 是全量/完成文本（覆盖）
          // （如 transcript.text.done 事件携带完整 text，若用 += 会重复一遍）
          if (typeof obj.text === 'string') full = obj.text;
          else if (typeof obj.delta === 'string') full += obj.delta;
        } catch {
          /* 跳过无法解析的行 */
        }
      }
    }
  } else {
    const obj = await res.json();
    if (typeof obj.text === 'string') full = obj.text;
    else if (typeof obj.delta === 'string') full = obj.delta;
    else full = JSON.stringify(obj);
  }
  return full.trim();
}
