// dove-input-monitor —— 全局输入监听 helper（M7 / T7.4）
//
// 用法：
//   dove-input-monitor           长驻；事件按 NDJSON 一行一个对象写 stdout
//   dove-input-monitor --check   只打印一行权限状态后退出（给 TS 侧 isAccessibilityGranted 用）
//
// 事件行（字段随类型不同，顺序无所谓）：
//   {"kind":"permission","granted":false,"hint":"…"}
//   {"kind":"app","app":"Safari","bundleId":"com.apple.Safari","pid":123,"windowTitle":"…","ts":1699999999999}
//   {"kind":"key","keyCode":12,"modifiers":["cmd"],"repeat":false,"ts":…}
//   {"kind":"leftMouseDown","x":100.5,"y":200.0,"ts":…}
//   {"kind":"rightMouseDown","x":…,"y":…,"ts":…}
//   {"kind":"scroll","dx":0.0,"dy":-3.0,"x":…,"y":…,"ts":…}
//
// 隐私纪律：keyDown **只记 keyCode 与修饰键，绝不记录字符/输入法内容**（键盘内容一个字都不落盘）。
// 权限纪律：没有辅助功能权限时**不注册**键盘/鼠标全局监听（注册了也收不到），
//          只发 app 切换事件 —— 那条路走 NSWorkspace 通知，不需要任何权限。
// 生命周期：SIGTERM/SIGINT 默认终止；父进程退出导致 stdin EOF 时自行退出（不留孤儿进程）。
// UI：只有 run loop，没有窗口/菜单/Dock 图标（setActivationPolicy(.prohibited)）。

import AppKit
import ApplicationServices
import Foundation

func nowMs() -> Int { return Int(Date().timeIntervalSince1970 * 1000.0) }

/// 一行 NDJSON（FileHandle 直写，绕过 stdio 缓冲：父进程能立刻读到）
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

/// 辅助功能权限探测（prompt=false：不弹系统对话框，引导交给 TS 侧的 openAccessibilitySettings）
func accessibilityGranted() -> Bool {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    return AXIsProcessTrustedWithOptions([key: false] as CFDictionary)
}

/// 修饰键 → 名称数组（只记修饰键，不记字符）
func modifierNames(_ flags: NSEvent.ModifierFlags) -> [String] {
    var out: [String] = []
    if flags.contains(.command) { out.append("cmd") }
    if flags.contains(.shift) { out.append("shift") }
    if flags.contains(.control) { out.append("ctrl") }
    if flags.contains(.option) { out.append("opt") }
    if flags.contains(.function) { out.append("fn") }
    if flags.contains(.capsLock) { out.append("caps") }
    return out
}

/// 前台窗口标题（需要辅助功能权限；拿不到就返回 nil，绝不阻塞太久）
func focusedWindowTitle(pid: pid_t) -> String? {
    guard AXIsProcessTrusted() else { return nil }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.4)
    var windowRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
          let windowRef else { return nil }
    var titleRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(windowRef as! AXUIElement, kAXTitleAttribute as CFString, &titleRef) == .success,
          let title = titleRef as? String, !title.isEmpty else { return nil }
    return title
}

/// 当前前台应用 → 事件；有权限时补窗口标题（等 150ms 让目标 app 把窗口挂好）
func emitFrontmost(_ app: NSRunningApplication?) {
    guard let app else { return }
    var obj: [String: Any] = [
        "kind": "app",
        "app": app.localizedName ?? "unknown",
        "pid": Int(app.processIdentifier),
        "ts": nowMs(),
    ]
    if let bundleId = app.bundleIdentifier { obj["bundleId"] = bundleId }
    guard AXIsProcessTrusted() else { emit(obj); return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
        var full = obj
        if let title = focusedWindowTitle(pid: app.processIdentifier) { full["windowTitle"] = title }
        emit(full)
    }
}

// ── 入口 ─────────────────────────────────────────────────
let granted = accessibilityGranted()
if CommandLine.arguments.contains("--check") {
    emit(["kind": "permission", "granted": granted, "ts": nowMs()])
    exit(0)
}

var hello: [String: Any] = ["kind": "permission", "granted": granted, "ts": nowMs()]
if !granted {
    hello["hint"] = "未获得「辅助功能」权限：只记录 app 切换事件；键盘/鼠标事件被系统屏蔽。请在 系统设置 → 隐私与安全性 → 辅助功能 中勾选运行 Dove 的程序。"
}
emit(hello)

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)   // 不出现 Dock 图标

// 防孤儿，双保险：
// ① 父进程退出 → stdin 管道关闭 → 读到 EOF 自行退出
// ② 每秒看一次 getppid()：父进程一死，我们会被过继给 launchd（ppid 变 1）→ 也退出
//    通道语义在某些宿主下（被别的进程继承了写端）可能不触发 EOF，所以 ② 不是多余的。
let parentPid = getppid()
DispatchQueue.global().async {
    while true {
        let data = FileHandle.standardInput.availableData
        if data.isEmpty { exit(0) }
    }
}
DispatchQueue.global().async {
    while true {
        Thread.sleep(forTimeInterval: 1.0)
        if getppid() != parentPid || getppid() == 1 { exit(0) }
    }
}

// 无权限时故意不注册：全局键盘/鼠标监听在未授权时收不到事件
if granted {
    let mask: NSEvent.EventTypeMask = [.keyDown, .leftMouseDown, .rightMouseDown, .scrollWheel]
    _ = NSEvent.addGlobalMonitorForEvents(matching: mask) { event in
        let ts = nowMs()
        switch event.type {
        case .keyDown:
            emit([
                "kind": "key",
                "keyCode": Int(event.keyCode),
                "modifiers": modifierNames(event.modifierFlags),
                "repeat": event.isARepeat,
                "ts": ts,
            ])
        case .leftMouseDown, .rightMouseDown:
            let p = NSEvent.mouseLocation
            emit([
                "kind": event.type == .leftMouseDown ? "leftMouseDown" : "rightMouseDown",
                "x": Double(p.x), "y": Double(p.y), "ts": ts,
            ])
        case .scrollWheel:
            let p = NSEvent.mouseLocation
            emit([
                "kind": "scroll",
                "dx": Double(event.scrollingDeltaX), "dy": Double(event.scrollingDeltaY),
                "x": Double(p.x), "y": Double(p.y), "ts": ts,
            ])
        default:
            break
        }
    }
}

// app 切换：NSWorkspace 通知，不需要辅助功能权限
NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { note in
    emitFrontmost(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
}
emitFrontmost(NSWorkspace.shared.frontmostApplication)

app.run()
