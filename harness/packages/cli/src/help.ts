/**
 * 帮助文本（单独一份，和命令实现分开）
 *
 * 为什么不允许这里偷懒：CLI 的 --help 是它唯一的说明书（这个仓库不长 .md 文档）。
 * 每条命令都要写清「默认落到哪个线程 / 退出码 / 端点」，否则用户会去猜默认行为，
 * 而默认行为猜错的代价是：一条消息跑进了别的会话。
 */

export const MAIN_HELP = `dove —— 内核（常驻服务）的命令行客户端

用法：dove <命令> [选项] [参数]

  health              内核在不在、端口、工具数、模型（--json）
  status              上面这些 + 工作区、配置目录、线程数（--json）
  version             CLI 与内核版本（内核没跑也能答）
  up                  后台把内核起起来（日志进 ~/.dove/logs/cli-kernel.log）
  logs [--tail 50]    看内核的运行时日志（--level error/warn）
  threads list|show|new|rm
                      线程：列出 / 看消息 / 新建 / 删除
  run "<消息>"        跑一轮，流式打到 stdout
                      --thread <id> | --new | --home（默认 home）
                      --json（每行一个事件的 NDJSON）| --quiet | --verbose
                      --no-inline-approve（不在本终端就地审批，仍打印 dove approve 提示）
  chat                交互 REPL（/exit /new /threads /stop）
  stop [--thread <id>]   停掉正在跑的回合（默认 home 线程）
  steer "<消息>"         给正在跑的回合插话（下一个 step 生效）
  approve [--allow|--deny|--tool-call-id <id>]
                      列出待审批并在终端里允许/拒绝
  pending             只列待审批，不做决定
  answer [--id <id>] "<文本>"
                      回答 AskUserQuestion（不给 --id 就用最近一次提问）
  tools [--json]      工具清单（内核较旧时给提示，不报错）
  skills [--json]     技能包（核对 /api/skills，没有就直接读磁盘）
  goals / goal create|get|update|clear
                      长期目标（get 默认 home 线程）
  help <命令>         看某个命令的详细用法

全局选项：
  --port <n>          指定内核端口（默认按 DOVE_PORT > ~/.dove/port > 扫 8790..8799 找）
  --json              机器可读输出（纯 NDJSON，不带颜色）
  --no-color          关掉颜色（非 TTY 本来就不上色）
  --no-inline-approve 关掉「就地审批」（默认只有 TTY 才问）

退出码：0 成功 · 1 失败 · 2 用法错 · 3 连不上内核 · 4 内核报错 · 130 被中断
`;

const COMMANDS: Record<string, string> = {
  health: `dove health [--port <n>] [--json]\n\n  确认内核在跑、跑在哪个端口（端口来源会一起打出来，找错地方时一眼能看出来）。`,
  status: `dove status [--port <n>] [--json]\n\n  比 health 多：模型/工具模型、工作区、配置目录、线程数。`,
  version: `dove version [--port <n>] [--json]\n\n  同时给 CLI 与内核的版本。内核没跑也返回 0（这是它和 health 的区别）。`,
  up: `dove up [--port <n>] [--timeout <秒>] [--json]\n\n  后台启动内核并轮询 /api/health 直到就绪：\n    · 父进程 unref，内核不跟着 CLI 退出（它本来就是常驻服务）\n    · 日志 ~/.dove/logs/cli-kernel.log（DOVE_CONFIG 改了就跟过去）\n    · 端口已经在跑就不重复启动，直接返回 0`,
  logs: `dove logs [--tail <n>] [--level error|warn|info|log|debug] [--json]\n\n  内核的 console 输出（环形缓冲 + 磁盘分片）。排「模型为什么没回答」先看它。`,
  threads: `dove threads <list|show|new|rm> [...]\n\n  list          列出所有线程（按最近更新排序）\n  show <id>     看某个线程最近的消息（--limit N，默认 20）\n  new <标题>    新建线程（默认 project 类型；--home 建 home 类型）\n  rm <id>       删除线程（消息一起删，不可恢复）\n\n  都支持 --json。`,
  run: `dove run "<消息>" [--thread <id> | --new | --home] [--json] [--quiet] [--verbose]\n\n  默认落在 home 线程（它是常驻调度线程，不会莫名其妙跑进某个项目）。\n  --new 会用消息开头几个字当标题新建一个 project 线程。\n  流式输出走 stdout，提示/工具行/统计走 stderr —— 所以\n    dove run --quiet "..." > answer.txt\n  拿到的是干净的答案。\n  Ctrl+C 会先让内核停掉这个线程，再退出（退出码 130）。`,
  chat: `dove chat [--thread <id> | --new | --home] [--quiet]\n\n  交互式对话，同一个线程连着聊多轮。\n  /exit /quit    退出\n  /new [标题]    换个新线程接着聊\n  /threads       列出线程（● 是当前）\n  /stop          停掉当前线程在跑的回合\n  Ctrl+C：回合跑着时 = 停这一轮；在提示符上 = 退出。`,
  stop: `dove stop [--thread <id>] [--json]\n\n  停掉某个线程正在跑的回合（默认 home）。没有在跑的回合不算失败（幂等）。`,
  steer: `dove steer "<消息>" [--thread <id>] [--json]\n\n  给正在跑的回合插话：内核会在下一个 step 把它读进去，不用等这一轮结束。`,
  approve: `dove approve [--allow | --deny | --tool-call-id <id> [--deny]] [--reason <文本>] [--json]\n\n  列出待审批的工具调用，并让你在终端里表态。\n  不给任何选项时：TTY 下逐条问（先问「全部允许？」），非 TTY 只列出来。\n  --allow/--deny 批量表态（无人值守用它）。\n  审批等待默认 5 分钟就超时并按拒绝处理（DOVE_APPROVAL_TIMEOUT_MS 可调）。`,
  pending: `dove pending [--json]\n\n  只列待审批，不做决定。`,
  answer: `dove answer [--id <toolCallId>] "<文本>" [--json]\n\n  回答 AskUserQuestion。不给 --id 就用「最近一次提问」\n  （由 dove run 看到提问事件时记下来的）。`,
  tools: `dove tools [--json]\n\n  工具清单（GET /api/tools/list）。内核较旧、没有这个端点时给一句提示并返回 0 ——\n  因为它只影响「看得见多少」，不影响干活。`,
  skills: `dove skills [--json]\n\n  技能包（name + 一句话）。优先问 /api/skills；没有就直接读\n  <工作区>/skills · <工作区>/.dove/skills · ~/.dove/skills。`,
  goals: `dove goals [--json]\n\n  列目标。优先 /api/goals；老内核上逐个项目查（home 线程的目标那时看不到）。`,
  goal: `dove goal <create|get|update|clear> [--thread <id>] [...]\n\n  create "<目标>" [--max-rounds 20]\n  get\n  update --pause|--resume|--complete|--blocked [--reason <原因>]\n  clear\n\n  默认线程是 home。内核没有 /api/goal* 时，项目线程会自动退回\n  /api/projects/<项目>/goal。`,
  help: `dove help [命令]\n\n  不带参数打总览，带命令名看那一条的详细用法。`,
};

export function helpFor(cmd: string): string {
  return COMMANDS[cmd] ?? MAIN_HELP;
}
