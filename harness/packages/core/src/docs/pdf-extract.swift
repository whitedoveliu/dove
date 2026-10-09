// dove-pdf-extract —— PDF 文本提取 helper（文档解析降级：PDF → 文本）
//
// 用法：
//   dove-pdf-extract <file.pdf> [from [to]]     逐页提取文本，每页一行 JSON 写 stdout
//   dove-pdf-extract --render <out.pdf> <text>  自测用：CoreGraphics 生成一页含文字的 PDF
//   dove-pdf-extract --check                    能力探测：打印一行 JSON 后退出
//
// 输出（NDJSON，一行一个对象，text 内的换行由 JSON 转义）：
//   {"pages":12}
//   {"page":1,"text":"……"}
// 退出码：0 正常 / 2 参数错 / 3 PDF 打不开 / 4 写出失败

import Foundation
import PDFKit
import CoreGraphics
import CoreText

func fail(_ code: Int32, _ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

/// 一行 NDJSON（FileHandle 直写，不经过 stdio 缓冲，父进程能立刻读到）
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

/// 逐页提取；from/to 为 1 起闭区间，越界自动夹到 [1, pageCount]
func extract(path: String, from: Int, to: Int) -> Int32 {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else {
        fail(3, "无法打开 PDF（文件损坏、加密或不是 PDF）：\(path)")
    }
    let count = doc.pageCount
    if count <= 0 { fail(3, "PDF 没有任何页面：\(path)") }
    emit(["pages": count])
    let start = max(1, min(from, count))
    let end = max(start, min(to, count))
    for index in (start - 1)...(end - 1) {
        let text = doc.page(at: index)?.string ?? ""
        emit(["page": index + 1, "text": text])
    }
    return 0
}

/// 自测用：生成一页含文字的 PDF（与 ocr.swift 的 --render 同思路）
func render(out: String, text: String) -> Int32 {
    var mediaBox = CGRect(x: 0, y: 0, width: 612, height: 792)
    guard let ctx = CGContext(URL(fileURLWithPath: out) as CFURL, mediaBox: &mediaBox, nil) else {
        fail(4, "无法创建 PDF 上下文：\(out)")
    }
    ctx.beginPDFPage(nil)
    let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 36, nil)
    let attrs: [NSAttributedString.Key: Any] = [
        kCTFontAttributeName as NSAttributedString.Key: font,
        kCTForegroundColorAttributeName as NSAttributedString.Key: CGColor(red: 0, green: 0, blue: 0, alpha: 1),
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
    ctx.textPosition = CGPoint(x: 72, y: 700)
    CTLineDraw(line, ctx)
    ctx.endPDFPage()
    ctx.closePDF()
    print(out)
    return 0
}

// ── 入口 ─────────────────────────────────────────────────
let args = CommandLine.arguments
if args.count >= 2 && args[1] == "--check" {
    emit(["ok": true, "engine": "PDFKit"])
    exit(0)
}
if args.count >= 4 && args[1] == "--render" {
    exit(render(out: args[2], text: args[3...].joined(separator: " ")))
}
guard args.count >= 2 else {
    fail(2, "用法：dove-pdf-extract <file.pdf> [from [to]] | --render <out.pdf> <text> | --check")
}
let from = args.count >= 3 ? (Int(args[2]) ?? 1) : 1
let to = args.count >= 4 ? (Int(args[3]) ?? Int.max) : Int.max
exit(extract(path: args[1], from: from, to: to))
