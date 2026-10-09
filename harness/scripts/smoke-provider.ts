import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OpenAICompatProvider } from "../packages/core/src/providers/openai-compat.ts";

// 从仓库根读 env（.gitignore 挡住了，不会进版本库）。
// 也支持用环境变量覆盖 —— 别人不一定把这个文件放在同一个位置。
const ENV_PATH = process.env.DOVE_ENV_FILE ?? resolve(import.meta.dirname, "../../../env");
const env = readFileSync(ENV_PATH, "utf8");
const key = /^ANTHROPIC_API_KEY=(.+)$/m.exec(env)![1]!.trim();

const p = new OpenAICompatProvider({ id: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: key, supportsReasoning: true });

const r = await p.stream({
  model: "deepseek-chat",
  messages: [{ role: "user", content: "List the files in /tmp using the tool, then say done." }],
  tools: [{
    type: "function",
    function: { name: "list_dir", description: "List files in a directory", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  }],
  onTextDelta: (d) => process.stdout.write(d),
});
console.log("\n--- RESULT ---");
console.log("text:", JSON.stringify(r.text.slice(0, 200)));
console.log("toolCalls:", JSON.stringify(r.toolCalls));
console.log("usage:", JSON.stringify(r.usage));
console.log("finish:", r.finishReason);
