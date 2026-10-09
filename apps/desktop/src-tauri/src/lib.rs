use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::Manager;

/// 持有 sidecar 子进程句柄，app 退出时回收
struct AgentSidecar(Mutex<Option<Child>>);

/// 启动器已在跑 agent API 时会设置 DOVE_NO_SIDECAR=1，
/// 避免第二个实例去抢端口（抢不到还会触发一次无谓的退出清理）
fn sidecar_disabled() -> bool {
    matches!(std::env::var("DOVE_NO_SIDECAR"), Ok(v) if !v.is_empty() && v != "0")
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
    if sidecar_disabled() {
        println!("[dove] 检测到 DOVE_NO_SIDECAR，复用已有的 harness");
        return None;
    }
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

/// 开发期：直接从仓库里跑 harness
#[cfg(debug_assertions)]
fn spawn_agent_sidecar() -> Option<Child> {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..").join("..").join(".."); // src-tauri -> apps/desktop -> apps -> repo
    spawn_harness(&repo.join("harness"))
}

/// 发布期：从 .app 的 Resources 里启动打包好的 harness
///
/// 需要把 harness/ 整个目录 + 一个 node 二进制一起放进 Resources。
/// 打包脚本见 docs/desktop-packaging.md。
#[cfg(not(debug_assertions))]
fn spawn_agent_sidecar(app: &tauri::App) -> Option<Child> {
    let res = match app.path().resource_dir() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[dove] 无法解析资源目录: {e}");
            return None;
        }
    };
    let harness = res.join("harness");
    if !harness.exists() {
        eprintln!("[dove] harness 未打包进应用: {}", harness.display());
        return None;
    }
    // 打包时可把一个 node 放进 harness/bin/node
    let bundled = harness.join("bin/node");
    if bundled.exists() {
        std::env::set_var("DOVE_NODE", &bundled);
    }
    spawn_harness(&harness)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let child = {
                #[cfg(debug_assertions)]
                { spawn_agent_sidecar() }
                #[cfg(not(debug_assertions))]
                { spawn_agent_sidecar(app) }
            };
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

                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
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
                    std::thread::sleep(std::time::Duration::from_millis(300));
                }

                if !ready {
                    eprintln!("[dove] 内核 60 秒没起来，窗口停在过渡页");
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