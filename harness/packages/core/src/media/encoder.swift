// dove-video-encoder —— 用 AVFoundation 把一批图片/文字帧编码成 H.264 MP4（零依赖）
//
// 用法：
//   dove-video-encoder <manifest.json>            编码视频，结果 JSON 写 stdout
//   dove-video-encoder --render-frame <spec.json> <out.png>   只渲染一张文字帧 PNG
//   dove-video-encoder --probe                    自检（打印 ok 与系统信息）
//
// manifest.json：
//   { "out": "/abs/x.mp4", "width": 1280, "height": 720, "fps": 24,
//     "frames": [ { "image": "/abs/a.png", "seconds": 2 }, { "spec": { ...帧描述... }, "seconds": 2 } ] }
//
// 约束：只依赖 AVFoundation / CoreGraphics / CoreText / ImageIO / CoreVideo，不 import AppKit。
// 退出码：0 正常 / 2 参数错 / 3 清单或图片读不出 / 4 编码失败 / 5 渲染失败

import Foundation
import AVFoundation
import CoreGraphics
import CoreText
import CoreVideo
import ImageIO
import UniformTypeIdentifiers

// ── 数据模型 ─────────────────────────────────────────────
struct FrameSpec: Decodable {
    var width: Int?
    var height: Int?
    var title: String?
    var subtitle: String?
    var body: [String]?
    var footer: String?
    var accent: String?
    var bg: String?
    var index: Int?
    var total: Int?
}

struct FrameItem: Decodable {
    var image: String?
    var spec: FrameSpec?
    var seconds: Double?
}

struct Manifest: Decodable {
    var out: String
    var width: Int
    var height: Int
    var fps: Int?
    var bg: String?
    var frames: [FrameItem]
}

func fail(_ code: Int32, _ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

// ── 颜色 / 字体 ──────────────────────────────────────────
func color(_ hex: String?, _ fallback: CGColor) -> CGColor {
    guard var s = hex?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return fallback }
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6, let v = UInt32(s, radix: 16) else { return fallback }
    return CGColor(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255,
                   blue: CGFloat(v & 0xff) / 255, alpha: 1)
}

/** 中文字体优先（PingFang SC 在 macOS 上必然存在），失败再退回系统字体 */
func font(_ size: CGFloat, bold: Bool) -> CTFont {
    let names = bold ? ["PingFangSC-Semibold", "STHeitiSC-Medium", "Helvetica-Bold"]
                     : ["PingFangSC-Regular", "STHeitiSC-Light", "Helvetica"]
    for n in names {
        let f = CTFontCreateWithName(n as CFString, size, nil)
        let family = CTFontCopyFamilyName(f) as String
        if !family.isEmpty && family != ".AppleSystemUIFont" { return f }
    }
    return CTFontCreateUIFontForLanguage(.system, size, nil) ?? CTFontCreateWithName("Helvetica" as CFString, size, nil)
}

/** 段落样式（行距） */
func paragraph(_ spacing: CGFloat) -> CTParagraphStyle {
    var s = spacing
    return withUnsafePointer(to: &s) { p in
        var setting = CTParagraphStyleSetting(spec: .lineSpacingAdjustment,
                                              valueSize: MemoryLayout<CGFloat>.size, value: p)
        return CTParagraphStyleCreate(&setting, 1)
    }
}

/** 在矩形内排版一段文字；rect 用「左上角原点」坐标（内部转成 CG 的下原点） */
func drawText(_ text: String, font f: CTFont, color c: CGColor, rect: CGRect,
              canvasHeight: CGFloat, ctx: CGContext, lineSpacing: CGFloat) {
    if text.isEmpty || rect.width <= 1 || rect.height <= 1 { return }
    let attrs: [NSAttributedString.Key: Any] = [
        kCTFontAttributeName as NSAttributedString.Key: f,
        kCTForegroundColorAttributeName as NSAttributedString.Key: c,
        kCTParagraphStyleAttributeName as NSAttributedString.Key: paragraph(lineSpacing),
    ]
    let attributed = NSAttributedString(string: text, attributes: attrs)
    let framesetter = CTFramesetterCreateWithAttributedString(attributed)
    let flipped = CGRect(x: rect.minX, y: canvasHeight - rect.maxY, width: rect.width, height: rect.height)
    let path = CGPath(rect: flipped, transform: nil)
    let frame = CTFramesetterCreateFrame(framesetter, CFRange(location: 0, length: 0), path, nil)
    CTFrameDraw(frame, ctx)
}

// ── 画一帧 ───────────────────────────────────────────────
/** 把一帧画进上下文；index/total 用于页码。image 为空时画文字版式 */
func drawFrame(ctx: CGContext, width: Int, height: Int, spec: FrameSpec?, image: CGImage?,
               defaultBg: String?, index: Int, total: Int) {
    let w = CGFloat(width), h = CGFloat(height)
    let bg = color(spec?.bg ?? defaultBg, image != nil ? color("#101010", CGColor(gray: 0.06, alpha: 1))
                                                       : color("#FFFFFF", CGColor(gray: 1, alpha: 1)))
    ctx.setFillColor(bg)
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))

    if let img = image {
        // 等比缩放居中（letterbox）
        let iw = CGFloat(img.width), ih = CGFloat(img.height)
        let scale = min(w / max(iw, 1), h / max(ih, 1))
        let dw = iw * scale, dh = ih * scale
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: (w - dw) / 2, y: (h - dh) / 2, width: dw, height: dh))
        return
    }

    let accent = color(spec?.accent, color("#2F5D50", CGColor(red: 0.18, green: 0.36, blue: 0.31, alpha: 1)))
    let ink = color("#1F1C18", CGColor(gray: 0.1, alpha: 1))
    let sub = color("#33302B", CGColor(gray: 0.25, alpha: 1))

    // 左侧色条 + 顶部细线
    ctx.setFillColor(accent)
    ctx.fill(CGRect(x: 0, y: 0, width: w * 0.016, height: h))
    ctx.fill(CGRect(x: w * 0.09, y: h * 0.155, width: w * 0.10, height: max(3, h * 0.006)))

    let pad = w * 0.09
    drawText(spec?.title ?? "", font: font(h * 0.082, bold: true), color: ink,
             rect: CGRect(x: pad, y: h * 0.20, width: w - pad * 2, height: h * 0.20),
             canvasHeight: h, ctx: ctx, lineSpacing: h * 0.012)
    if let st = spec?.subtitle, !st.isEmpty {
        drawText(st, font: font(h * 0.042, bold: false), color: accent,
                 rect: CGRect(x: pad, y: h * 0.40, width: w - pad * 2, height: h * 0.10),
                 canvasHeight: h, ctx: ctx, lineSpacing: h * 0.010)
    }
    let bullets = (spec?.body ?? []).enumerated().map { "· " + $0.element }.joined(separator: "\n")
    drawText(bullets, font: font(h * 0.048, bold: false), color: sub,
             rect: CGRect(x: pad, y: h * 0.47, width: w - pad * 2, height: h * 0.42),
             canvasHeight: h, ctx: ctx, lineSpacing: h * 0.020)

    // 页码 / 页脚
    let label = spec?.footer ?? (total > 1 ? "\(index + 1) / \(total)" : "")
    drawText(label, font: font(h * 0.032, bold: false), color: sub,
             rect: CGRect(x: pad, y: h * 0.90, width: w - pad * 2, height: h * 0.07),
             canvasHeight: h, ctx: ctx, lineSpacing: 0)
}

/** 建一个位图上下文（BGRA 小端，和 CVPixelBuffer 一致） */
func makeContext(data: UnsafeMutableRawPointer?, width: Int, height: Int, bytesPerRow: Int) -> CGContext? {
    return CGContext(data: data, width: width, height: height, bitsPerComponent: 8, bytesPerRow: bytesPerRow,
                     space: CGColorSpaceCreateDeviceRGB(),
                     bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
}

func loadImage(_ path: String) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

func readJSON<T: Decodable>(_ path: String, _ type: T.Type) -> T {
    guard let data = FileManager.default.contents(atPath: path) else { fail(3, "读不到 JSON：\(path)") }
    do { return try JSONDecoder().decode(T.self, from: data) }
    catch { fail(3, "解析 JSON 失败（\(path)）：\(error)") }
}

// ── 渲染单张文字帧为 PNG ─────────────────────────────────
func renderFrame(specPath: String, out: String) {
    let spec = readJSON(specPath, FrameSpec.self)
    let width = spec.width ?? 1280, height = spec.height ?? 720
    guard let ctx = makeContext(data: nil, width: width, height: height, bytesPerRow: 0) else {
        fail(5, "无法创建绘图上下文")
    }
    drawFrame(ctx: ctx, width: width, height: height, spec: spec, image: nil,
              defaultBg: spec.bg, index: spec.index ?? 0, total: spec.total ?? 1)
    guard let image = ctx.makeImage(),
          let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL,
                                                     UTType.png.identifier as CFString, 1, nil) else {
        fail(5, "无法写出 PNG：\(out)")
    }
    CGImageDestinationAddImage(dest, image, nil)
    if !CGImageDestinationFinalize(dest) { fail(5, "PNG 落盘失败：\(out)") }
    print(out)
}

// ── 编码 MP4 ─────────────────────────────────────────────
func encode(manifestPath: String) {
    let m = readJSON(manifestPath, Manifest.self)
    guard m.width > 0, m.height > 0, !m.frames.isEmpty else { fail(2, "清单缺少 width/height/frames") }
    let fps = max(1, m.fps ?? 24)
    let width = m.width, height = m.height
    let outURL = URL(fileURLWithPath: m.out)
    try? FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: outURL)

    guard let writer = try? AVAssetWriter(outputURL: outURL, fileType: .mp4) else {
        fail(4, "无法创建 AVAssetWriter（输出路径不可写？）：\(m.out)")
    }
    writer.shouldOptimizeForNetworkUse = true
    let bitrate = min(12_000_000, max(1_200_000, width * height * fps / 12))
    let settings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: bitrate,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoMaxKeyFrameIntervalKey: fps * 2,
        ],
    ]
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
        kCVPixelBufferCGImageCompatibilityKey as String: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
    ])
    guard writer.canAdd(input) else { fail(4, "编码器不接受该输入（\(width)x\(height) H.264）") }
    writer.add(input)
    guard writer.startWriting() else { fail(4, "startWriting 失败：\(String(describing: writer.error))") }
    writer.startSession(atSourceTime: .zero)

    var pts = 0
    let total = m.frames.count
    for (i, item) in m.frames.enumerated() {
        var image: CGImage?
        if let p = item.image {
            guard let img = loadImage(p) else { fail(3, "图片读不出：\(p)") }
            image = img
        }
        let seconds = max(0.04, item.seconds ?? 2.0)
        let repeatCount = max(1, Int((seconds * Double(fps)).rounded()))
        for _ in 0..<repeatCount {
            var waited = 0
            while !input.isReadyForMoreMediaData {
                if writer.status != .writing { fail(4, "编码器提前结束：\(String(describing: writer.error))") }
                usleep(2000); waited += 1
                if waited > 30_000 { fail(4, "等待编码器就绪超时") }
            }
            guard let pool = adaptor.pixelBufferPool else { fail(4, "拿不到 pixel buffer 池") }
            var pb: CVPixelBuffer?
            guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb) == kCVReturnSuccess, let buf = pb else {
                fail(4, "分配 pixel buffer 失败")
            }
            CVPixelBufferLockBaseAddress(buf, [])
            if let ctx = makeContext(data: CVPixelBufferGetBaseAddress(buf), width: width, height: height,
                                     bytesPerRow: CVPixelBufferGetBytesPerRow(buf)) {
                drawFrame(ctx: ctx, width: width, height: height, spec: item.spec, image: image,
                          defaultBg: m.bg, index: i, total: total)
            }
            CVPixelBufferUnlockBaseAddress(buf, [])
            if !adaptor.append(buf, withPresentationTime: CMTime(value: Int64(pts), timescale: Int32(fps))) {
                fail(4, "写入第 \(pts) 帧失败：\(String(describing: writer.error))")
            }
            pts += 1
        }
    }
    input.markAsFinished()
    let sem = DispatchSemaphore(value: 0)
    writer.finishWriting { sem.signal() }
    sem.wait()
    guard writer.status == .completed else {
        fail(4, "finishWriting 失败：\(String(describing: writer.error))")
    }
    let attrs = try? FileManager.default.attributesOfItem(atPath: m.out)
    let bytes = (attrs?[.size] as? Int) ?? 0
    let payload: [String: Any] = [
        "ok": true, "path": m.out, "frames": pts,
        "durationMs": Int((Double(pts) / Double(fps) * 1000).rounded()),
        "width": width, "height": height, "fps": fps, "bytes": bytes,
    ]
    let data = (try? JSONSerialization.data(withJSONObject: payload, options: [])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

// ── 入口 ─────────────────────────────────────────────────
let args = CommandLine.arguments
if args.count >= 4 && args[1] == "--render-frame" {
    renderFrame(specPath: args[2], out: args[3])
    exit(0)
}
if args.count >= 2 && args[1] == "--probe" {
    let tmp = NSTemporaryDirectory() + "dove-probe-\(getpid()).mp4"
    let ok = (try? AVAssetWriter(outputURL: URL(fileURLWithPath: tmp), fileType: .mp4)) != nil
    try? FileManager.default.removeItem(atPath: tmp)
    print("{\"ok\":\(ok),\"system\":\"\(ProcessInfo.processInfo.operatingSystemVersionString)\"}")
    exit(0)
}
guard args.count >= 2 else { fail(2, "用法：dove-video-encoder <manifest.json> | --render-frame <spec.json> <out.png> | --probe") }
encode(manifestPath: args[1])
