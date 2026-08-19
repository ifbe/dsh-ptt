// 全局共享 stdout 输出队列：所有输出（模型流/think/工具/输入日志）串行写出，
// 防止流式输出过程中新输入直接打到 stdout 造成交错混乱。
export function createOutputQueue() {
  const queue = [];
  let flushing = false;

  /** 写一段文本（无换行追加） */
  const write = (s) => {
    queue.push(String(s));
    if (flushing) return;
    flushing = true;
    const next = () => {
      if (queue.length > 0) {
        process.stdout.write(queue.shift());
        setImmediate(next);
      } else {
        flushing = false;
      }
    };
    next();
  };

  /** 打一行日志（自动换行；多参数拼接） */
  const log = (...args) => {
    write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
  };

  const error = (...args) => {
    write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
  };

  return { write, log, error };
}
