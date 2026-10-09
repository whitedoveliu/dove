// dove-ocr —— Vision 文字识别 helper（M7 / T7.5）
//
// 用法：
//   dove-ocr <image>                     识别图片文字，逐行写 stdout
//   dove-ocr --render <out.png> <text>   自测用：CoreText 渲染一张白底黑字图片
//
// 约束：只依赖 Vision / ImageIO / CoreGraphics / CoreText，不 import AppKit。
// 退出码：0 正常 / 2 参数错 / 3 图片读不出 / 4 Vision 执行失败 / 5 渲染失败

import Foundation
import Vision
import ImageIO
import CoreGraphics
import CoreText
import UniformTypeIdentifiers

// 语言与识别精度（照抄规格：accurate + 语言校正 + en/zh-Hans/zh-Hant/ja）
let OCR_LANGUAGES = ["en-US", "zh-Hans", "zh-Hant", "ja"]

func fail(_ code: Int32, _ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

// ── OCR ───────────────────────────────────────────────────
func recognize(path: String) -> [String] {
    let url = URL(fileURLWithPath: path)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
        fail(3, "无法打开图片：\(path)")
    }
    guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        fail(3, "无法解码图片：\(path)")
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    // ⚠️ 语言表的**顺序决定识别结果**，不是提示而是硬约束：
    //    实测 ["en-US","zh-Hans",...] 对纯中文画面只吐 "iX"（Vision 锁死在拉丁字母上），
    //    换成 ["zh-Hans",...] 才能读出「紫水晶协议」。
    //    OCR_LANGUAGES 由 TS 侧传入，那里已经保证中文在前。
    request.recognitionLanguages = OCR_LANGUAGES
    // 让 Vision 自己也做一次语种判断（macOS 13+）。两条一起上更稳。
    if #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = true }
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        fail(4, "Vision 执行失败：\(error)")
    }
    var lines: [String] = []
    for observation in (request.results ?? []) {
        if let candidate = observation.topCandidates(1).first {
            lines.append(candidate.string)
        }
    }
    return lines
}

// ── 自测用：把文字渲染成 PNG ──────────────────────────────
func render(out: String, text: String) {
    let width = 1500, height = 300
    guard let ctx = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { fail(5, "无法创建绘图上下文") }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 96, nil)
    let attrs: [NSAttributedString.Key: Any] = [
        kCTFontAttributeName as NSAttributedString.Key: font,
        kCTForegroundColorAttributeName as NSAttributedString.Key: CGColor(red: 0, green: 0, blue: 0, alpha: 1),
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
    ctx.textPosition = CGPoint(x: 60, y: 110)
    CTLineDraw(line, ctx)
    guard let image = ctx.makeImage(),
          let dest = CGImageDestinationCreateWithURL(
            URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil
          ) else { fail(5, "无法写出 PNG：\(out)") }
    CGImageDestinationAddImage(dest, image, nil)
    if !CGImageDestinationFinalize(dest) { fail(5, "PNG 落盘失败：\(out)") }
    print(out)
}

// ── 入口 ─────────────────────────────────────────────────
let args = CommandLine.arguments
if args.count >= 4 && args[1] == "--render" {
    render(out: args[2], text: args[3...].joined(separator: " "))
    exit(0)
}
guard args.count >= 2 else {
    fail(2, "用法：dove-ocr <image> 或 dove-ocr --render <out.png> <text>")
}
print(recognize(path: args[1]).joined(separator: "\n"))
