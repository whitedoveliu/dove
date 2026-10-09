# Dove

一个通用的编码 agent —— 常驻 HTTP 内核 + 可换的界面，工具、记忆、子代理、权限都在里面。

```
改代码 → 构建自证 → 看效果 → 不满意就回滚
```

## 它是什么

不是一个聊天框包一层模型。核心是一个**常驻的 HTTP server**：

- **工具系统** —— 27 个内置工具，分「常驻 / 按需」两层。按需的要模型先检索再激活，
  工具描述**从工具的 `discoverable` 字段自动生成**，加删工具时不会漏
- **子代理** —— 上下文隔离。子代理在自己的上下文里翻文件、试错，只把结论带回来；
  运行过程**落盘成一条子线程**，可以点进去看它的推理和工具调用
- **记忆** —— ONNX 本地向量（bge-small-zh）+ 三路注入（语义 / 词法 / 记忆通道），
  阈值是实测标定的，不是抄的
- **权限** —— 三档（仅可查看 / 工作区内修改 / 完全权限），外加一个实验性的
  `auto`（无沙箱，但每次调用前让模型自己审一遍）
- **审批分类器** —— 命令先过本地规则（只读放行 / 危险拦截），拿不准才交给 LLM

## 快速开始

需要 **Node 24+**。

```bash
git clone https://github.com/whitedoveliu/dove.git
cd dove

# 配置（至少一个模型 key）
export DOVE_API_KEY=...          # OpenAI 兼容接口

# 起内核（默认 8790）
./Dove.command
```

浏览器打开 http://127.0.0.1:8790/ 就是界面。

**可选：向量模型**（不装的话记忆检索退化成字面匹配）

```bash
node --no-warnings packages/embedding/scripts/fetch-model.mjs
```

## 结构

```
harness/            TS 内核
  packages/core/      agent 循环、工具、记忆、子代理、审批
  packages/server/    常驻 HTTP server（内核 API + 老契约兼容层）
  packages/prompts/   系统提示词的 11 个槽位（s01-s11，各自独立文件）
  packages/embedding/ 向量检索
  scripts/            冒烟测试
control-panel/      界面（React + Vite）
apps/desktop/       桌面壳（Tauri）
```

## 开发

```bash
# 回归（改完东西跑这个）
./verify.sh

# 单独跑
cd harness
npm run lint                              # 文件大小 + 依赖方向
node --no-warnings --test packages/core/test/core.test.ts
node --no-warnings scripts/smoke-turn.ts  # 真跑一轮对话
```

**纪律（这个项目踩出来的）：**

- **改了运行路径上的代码，必须跑一次真实执行。** 只跑 lint + 单测会漏掉整类 bug ——
  本项目为此栽过多次：引用了不存在的变量、const 的暂时性死区、
  "字段声明了但没人传"（值传到一半静默消失）
- **文件 ≤ 400 行**，超了就拆
- **依赖方向单向**（见 `tools/lint-layering.mjs`）

## 几个设计决定

**为什么工具分常驻/按需**：工具描述每轮都要发给模型。常驻 17 个，
另外 7 个按需加载 —— 但**必须让模型知道有什么可搜**，所以检索工具的描述
是从工具列表生成的，不是手写的（手写过，漏了子代理，模型就再也没派过子代理）。

**为什么子代理过程要落盘**：子代理跑很久且是黑盒。存成一条 `kind='subagent'` 的
子线程后，界面可以直接复用主对话的历史回放路径，不用另写一套渲染。

**为什么审批要看命令链的每一段**：白名单正则都是 `^` 锚定的，
只看开头的话 `ls && rm -rf ~/Documents` 会被判成只读直接放行。

## License

MIT
