const INTERNAL_LOG_MARKER_RE = /\*{5,}\s*内部日志\s*\*{5,}/g;

function formatTodoUpdate(line: string): string | null {
  const match = line.match(/更新任务列表\s*\(merge=(True|False|true|false),\s*count=(\d+)\)/i);
  if (!match) return null;

  const merge = match[1].toLowerCase() === "true";
  const count = Number(match[2] || "0");
  return `📋 Todo 更新：${count} 项（${merge ? "合并" : "替换"}）`;
}

function formatFileWriteResult(line: string): string | null {
  const match = line.match(/['"]message['"]:\s*['"]File\s+(.+?)\s+created\/overwritten successfully['"]/i);
  if (!match) return null;
  return `✅ 已写入文件：${match[1]}`;
}

function formatGenericStatusResult(line: string): string | null {
  const statusMatch = line.match(/['"]status['"]:\s*['"]?([a-zA-Z_]+)['"]?/i);
  const messageMatch = line.match(/['"]message['"]:\s*['"](.+?)['"]/i);

  if (!statusMatch || !messageMatch) return null;

  const status = statusMatch[1].toLowerCase();
  const prefix = ["success", "ok", "completed"].includes(status) ? "✅" : "⚠️";
  return `${prefix} ${messageMatch[1]}`;
}

function normalizeSingleLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (INTERNAL_LOG_MARKER_RE.test(trimmed)) {
    INTERNAL_LOG_MARKER_RE.lastIndex = 0;
    return null;
  }
  INTERNAL_LOG_MARKER_RE.lastIndex = 0;

  if (trimmed.startsWith("📋 收到的完整参数:")) {
    return null;
  }

  return (
    formatTodoUpdate(trimmed) ||
    formatFileWriteResult(trimmed) ||
    formatGenericStatusResult(trimmed) ||
    trimmed
  );
}

export function sanitizeLogContent(content?: string | null): string {
  if (!content) return "";

  const lines = content
    .replace(/\r/g, "")
    .replace(INTERNAL_LOG_MARKER_RE, "\n")
    .split("\n")
    .map((line) => normalizeSingleLine(line))
    .filter((line): line is string => Boolean(line));

  const deduped: string[] = [];
  for (const line of lines) {
    if (deduped[deduped.length - 1] !== line) {
      deduped.push(line);
    }
  }

  return deduped.join("\n").trim();
}

export function mergeLogContent(existing?: string | null, incoming?: string | null): string {
  const previous = sanitizeLogContent(existing);
  const next = sanitizeLogContent(incoming);

  if (!previous) return next;
  if (!next) return previous;

  const merged = [...previous.split("\n")];
  for (const line of next.split("\n")) {
    if (merged[merged.length - 1] !== line) {
      merged.push(line);
    }
  }

  return merged.join("\n").trim();
}
