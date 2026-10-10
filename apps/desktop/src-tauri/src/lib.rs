use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::Manager;

/// 持有 sidecar 子进程句柄，app 退出时回收
struct AgentSidecar(Mutex<Option<Child>>);

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// 屏幕录制权限：**由 App 自己申请**，不让内核里的临时 helper 去申请。
///
/// 为什么必须这样（用户反馈"每次重启都问一遍"的根因）：
/// macOS 的 TCC 把授权记在**发起申请的那个进程**头上。内核原来是用 swiftc
/// **运行时编译**出来的 helper（~/.dove/cache/screen-permission-<hash>）去调
/// CGRequestScreenCaptureAccess()，系统记的是那个临时二进制，不是 Dove.app；
/// 于是下一次换一个身份来问，系统又弹一遍 —— 用户永远点不完。
///
/// 在 App 里申请，授权就落在 Dove.app 上。注意 adhoc 签名的 app，TCC 绑的是
/// cdhash：**只要不替换这个二进制**，授权就一直在（所以装好之后别乱覆盖）。
///
/// 另外：CGRequestScreenCaptureAccess() 在"未决定"状态下每次调用都会弹，
/// 所以用一个标记文件保证**只问一次**，之后只在日志里引导用户去系统设置。
fn ensure_screen_permission() {
    unsafe {
        if CGPreflightScreenCaptureAccess() {
            println!("[dove] 屏幕录制权限: 已有");
            return;
        }
        let marker = std::env::var("HOME").ok()
            .map(|h| PathBuf::from(h).join(".dove").join(".screen-permission-requested"));
        if let Some(m) = &marker {
            if m.exists() {
                println!("[dove] 屏幕录制权限: 之前申请过仍未授权 —— 不再弹窗，需要时去「系统设置 → 隐私与安全性 → 屏幕录制」手动打开");
                return;
            }
        }
        let granted = CGRequestScreenCaptureAccess();
        if let Some(m) = &marker {
            if let Some(dir) = m.parent() { let _ = std::fs::create_dir_all(dir); }
            let _ = std::fs::write(m, "{\"source\":\"Dove.app\"}\n");
        }
        println!("[dove] 屏幕录制权限: 申请结果 granted={}", granted);
    }
}

/// 启动器已在跑 agent API 时会设置 DOVE_NO_SIDECAR=1，
/// 避免第二个实例去抢端口（抢不到还会触发一次无谓的退出清理）
fn sidecar_disabled() -> bool {
    matches!(std::env::var("DOVE_NO_SIDECAR"), Ok(v) if !v.is_empty() && v != "0")
}

/// 内核仓库的判定标志：这个文件存在，才认为是一个可用的 dove 仓库
const MARKER: &str = "harness/packages/server/src/main.ts";

fn looks_like_repo(dir: &Path) -> bool {
    dir.join(MARKER).exists()
}

/// 从 start 往上找（最多 8 层）
fn walk_up(start: &Path) -> Option<PathBuf> {
    let mut cur = Some(start.to_path_buf());
    for _ in 0..8 {
        let d = cur?;
        if looks_like_repo(&d) { return Some(d); }
        cur = d.parent().map(Path::to_path_buf);
    }
    None
}

/// 指针文件：`~/.dove/repo`，里面写一行仓库绝对路径（# 开头算注释）。
///
/// 为什么需要它：App 装在 /Applications 时离仓库很远，"往上找"永远找不到；
/// 而"编译期写死路径"正是这次要修掉的坑。
fn pointer_file() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".dove").join("repo"))
}

/// 把开头的 `~` 展开成 $HOME（只处理这一种写法，够用）
fn expand_user(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(p)
}

/// 解析内核仓库根 —— **运行时**解析，不再用编译期常量。
///
/// 历史坑：这里原来是 `env!("CARGO_MANIFEST_DIR")`，那是**编译期烘焙**的路径。
/// /Applications/Dove.app 是从 design_coder 那份源码 build 的，于是它永远去拉 design_coder 的
/// 内核与面板 —— 在 dove 仓库里改再多也看不见（实测：内核报 23 个工具、面板还是旧的那一份）。
///
/// 顺序：DOVE_REPO → ~/.dove/repo → 从可执行文件往上找 → 从当前工作目录往上找。
fn resolve_repo() -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var("DOVE_REPO") {
        let p = expand_user(raw.trim());
        if looks_like_repo(&p) { return Ok(p); }
        return Err(format!("DOVE_REPO 指向的不是 dove 仓库（缺 {MARKER}）：{}", p.display()));
    }
    if let Some(pf) = pointer_file() {
        if let Ok(text) = std::fs::read_to_string(&pf) {
            let line = text.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#'));
            if let Some(l) = line {
                let p = expand_user(l);
                if looks_like_repo(&p) { return Ok(p); }
                return Err(format!("{} 里写的路径不是 dove 仓库（缺 {MARKER}）：{}", pf.display(), p.display()));
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(r) = walk_up(dir) { return Ok(r); }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(r) = walk_up(&cwd) { return Ok(r); }
    }
    let hint = pointer_file().map(|p| p.display().to_string()).unwrap_or_else(|| "~/.dove/repo".to_string());
    Err(format!(
        "找不到 dove 仓库（往上找 {MARKER} 没找到）。三选一：\n\
         1) 设置环境变量 DOVE_REPO=/path/to/dove\n\
         2) 在 {hint} 里写一行仓库绝对路径\n\
         3) 从仓库目录里启动本 App"
    ))
}

/// 找一个可用的 node：优先环境变量，其次 PATH，最后几个常见位置
fn find_node() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("DOVE_NODE") {
        let pb = PathBuf::from(p);
        if pb.exists() { return Some(pb); }
    }
    let candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ];
    for c in candidates {
        let pb = PathBuf::from(c);
        if pb.exists() { return Some(pb); }
    }
    // 最后试 PATH
    if let Ok(out) = Command::new("which").arg("node").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() { return Some(PathBuf::from(s)); }
        }
    }
    None
}

/// 启动 harness：node packages/server/src/main.ts（工作目录 = harness/）
///
/// 换掉了原来的 Python FastAPI sidecar —— 内核已经整个重写成 TS 了。
/// 端口由 DOVE_PORT 控制（默认 8790），面板由内核自己托管。
fn spawn_harness(harness_dir: &Path) -> Option<Child> {
    let main = harness_dir.join("packages/server/src/main.ts");
    if !main.exists() {
        eprintln!("[dove] harness 入口未找到: {}", main.display());
        return None;
    }
    let node = match find_node() {
        Some(n) => n,
        None => {
            eprintln!("[dove] 找不到 node（>=24）。装一个，或设置 DOVE_NODE 指向它。");
            return None;
        }
    };
    println!("[dove] 用 {} 启动 harness", node.display());
    match Command::new(&node)
        .arg("--no-warnings")
        .arg(&main)
        .current_dir(harness_dir)
        // 内核自己盯着我们：App 被杀/崩溃时它跟着退出，不留孤儿进程占着端口
        .env("DOVE_EXIT_WITH_PARENT", "1")
        // 屏幕录制权限的**申请**归 App（见 ensure_screen_permission）：
        // 内核只做不弹窗的预检，绝不再自己申请 —— 否则 TCC 会把授权记在
        // 运行时编译的临时 helper 头上，导致每次启动都重问一遍。
        .env("DOVE_APP_OWNS_SCREEN_PERMISSION", "1")
        .spawn()
    {
        Ok(child) => {
            println!("[dove] harness 已启动 (pid {})", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("[dove] harness 启动失败: {e}");
            None
        }
    }
}

/// 把一段文本转成 JS 字符串字面量（给过渡页显示错误用）
fn js_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// 拉起 sidecar。返回 (子进程, 失败原因) —— 失败原因会显示在过渡页上。
///
/// 打包形态（Resources 里塞了 harness + node）优先；否则按**运行时解析**出的仓库跑。
fn spawn_agent_sidecar(app: &tauri::App) -> (Option<Child>, Option<String>) {
    if sidecar_disabled() {
        println!("[dove] 检测到 DOVE_NO_SIDECAR，复用已有的 harness");
        return (None, None);
    }
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("harness");
        if bundled.join("packages/server/src/main.ts").exists() {
            let node = bundled.join("bin/node");
            if node.exists() { std::env::set_var("DOVE_NODE", &node); }
            println!("[dove] 用打包进 App 的 harness: {}", bundled.display());
            return (spawn_harness(&bundled), None);
        }
    }
    match resolve_repo() {
        Ok(repo) => {
            println!("[dove] 内核仓库: {}", repo.display());
            (spawn_harness(&repo.join("harness")), None)
        }
        Err(msg) => {
            eprintln!("[dove] {msg}");
            (None, Some(msg))
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 先把屏幕录制权限要清楚（只在没问过时弹一次），再拉内核 ——
            // 内核起来后会读同一个 TCC 状态，不用再问。
            ensure_screen_permission();
            let (child, spawn_err) = spawn_agent_sidecar(app);
            app.manage(AgentSidecar(Mutex::new(child)));

            // 内核就绪后让窗口跳到它托管的界面。
            //
            // 为什么不在页面里 fetch 轮询：窗口初始加载的是本地过渡页（tauri:// 协议），
            // 从那里 XHR 到 http://127.0.0.1 会被 WebKit 当跨源拦掉 —— 实测卡在
            // 「还在等内核…」不动，而内核其实早就起来了。放到 Rust 侧探端口就没这问题。
            //
            // 为什么不让窗口直接加载 dist：控制面板的构建产物用的是绝对路径
            // （/assets/index-xxx.js），在 tauri:// 下解析不了 → 白屏。
            // 走内核的 HTTP 服务则路径、CORS、window.location.hostname 全对。
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let port: u16 = std::env::var("DOVE_PORT").ok()
                    .and_then(|v| v.parse().ok()).unwrap_or(8790);
                let url = format!("http://127.0.0.1:{}/", port);
                let addr = format!("127.0.0.1:{}", port);

                let started = std::time::Instant::now();
                let deadline = started + std::time::Duration::from_secs(60);
                let mut ready = false;
                while std::time::Instant::now() < deadline {
                    if std::net::TcpStream::connect_timeout(
                        &addr.parse().unwrap(),
                        std::time::Duration::from_millis(400),
                    ).is_ok() {
                        // 端口通了再等一下，确保 HTTP 路由也挂好了
                        std::thread::sleep(std::time::Duration::from_millis(400));
                        ready = true;
                        break;
                    }
                    // 已经知道拉不起来（比如找不到仓库）就别干等 60 秒
                    if spawn_err.is_some() && started.elapsed().as_secs() >= 5 { break; }
                    std::thread::sleep(std::time::Duration::from_millis(300));
                }

                if !ready {
                    eprintln!("[dove] 内核没起来，窗口停在过渡页");
                    if let Some(msg) = spawn_err {
                        if let Some(win) = handle.get_webview_window("main") {
                            let _ = win.eval(&format!("fail({})", js_string(&msg)));
                        }
                    }
                    return;
                }
                println!("[dove] 内核就绪 → {}", url);
                if let Some(win) = handle.get_webview_window("main") {
                    let js = format!("location.replace('{}')", url);
                    let _ = win.eval(&js);
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 退出时回收 sidecar 子进程
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<AgentSidecar>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                        let _ = child.wait();
                        println!("[dove] harness 已停止");
                    }
                }
            }
        });
}
