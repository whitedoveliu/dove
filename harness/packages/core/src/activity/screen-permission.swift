// 屏幕录制权限：申请 + 查询
//
// 为什么单独写一个：/usr/sbin/screencapture 只会在没权限时**静默失败**，
// 系统不会因此把这个 app 加进「屏幕录制」列表 —— 用户去设置里根本找不到它。
// 只有调 CGRequestScreenCaptureAccess() 才会弹系统提示并把 app 登记进去。
//
// 用法：screen-permission request | check
import Foundation
import CoreGraphics

let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "check"

if mode == "request" {
    // 首次调用会弹「xxx 想要录制此电脑的屏幕」；已决定过则直接返回当前状态
    let granted = CGRequestScreenCaptureAccess()
    print("{\"granted\": \(granted)}")
} else {
    let ok = CGPreflightScreenCaptureAccess()
    print("{\"granted\": \(ok)}")
}
