/**
 * GeneratePPT —— 生成真正可打开的 .pptx（零依赖）
 * 做法：PPTX 本质是 OOXML 的 ZIP 包。这里手写一个最小 ZIP（stored 方式）+ 最小 OOXML 部件集，
 *       生成只含「标题 + 要点」的幻灯片。够用、可打开、可继续编辑。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { defineTool } from "../types.ts";
import { guarded, str, optStr } from "./util.ts";

// ── 最小 ZIP 写入器（stored，不压缩） ─────────────────
interface Entry { name: string; data: Buffer }

function crc32(buf: Buffer): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(e.data.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, e.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(e.data.length, 20); ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + e.data.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, end]);
}

// ── OOXML 部件 ────────────────────────────────────────
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function textBody(lines: { text: string; size: number; bold?: boolean; color?: string }[]): string {
  const paras = lines.map((l) => [
    "<a:p>",
    `<a:pPr algn="l"/>`,
    "<a:r>",
    `<a:rPr lang="zh-CN" sz="${l.size}"${l.bold ? ' b="1"' : ""} dirty="0">`,
    l.color ? `<a:solidFill><a:srgbClr val="${l.color}"/></a:solidFill>` : "",
    "</a:rPr>",
    `<a:t>${esc(l.text)}</a:t>`,
    "</a:r>",
    "</a:p>",
  ].join("")).join("");
  return `<p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody>`;
}

function slideXml(title: string, bullets: string[], accent: string): string {
  const lines = [
    { text: title, size: 3200, bold: true, color: "1F1C18" },
    ...bullets.map((b) => ({ text: "• " + b, size: 1800, color: "33302B" })),
  ];
  return XML + `<p:sld xmlns:a="${NS_A}" xmlns:p="${NS_P}" xmlns:r="${NS_R}">` +
    "<p:cSld><p:spTree>" +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    "<p:grpSpPr/>" +
    // 左侧色条
    "<p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"accent\"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>" +
    `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="182880" cy="5143500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${accent}"/></a:solidFill></p:spPr>` +
    "<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>" +
    // 标题 + 要点
    "<p:sp><p:nvSpPr><p:cNvPr id=\"3\" name=\"content\"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>" +
    '<p:spPr><a:xfrm><a:off x="731520" y="548640"/><a:ext cx="7772400" cy="4572000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    textBody(lines) +
    "</p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>";
}

function buildPptx(slides: { title: string; bullets: string[] }[], accent: string): Buffer {
  const entries: Entry[] = [];
  const n = slides.length;
  const add = (name: string, xml: string) => entries.push({ name, data: Buffer.from(xml, "utf8") });

  add("[Content_Types].xml", XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("") +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    "</Types>");

  add("_rels/.rels", XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
    "</Relationships>");

  add("ppt/presentation.xml", XML + `<p:presentation xmlns:a="${NS_A}" xmlns:p="${NS_P}" xmlns:r="${NS_R}" saveSubsetFonts="1">` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    "<p:sldIdLst>" + slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("") + "</p:sldIdLst>" +
    '<p:sldSz cx="9144000" cy="5143500"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>');

  add("ppt/_rels/presentation.xml.rels", XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
    slides.map((_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("") +
    "</Relationships>");

  slides.forEach((s, i) => {
    add(`ppt/slides/slide${i + 1}.xml`, slideXml(s.title, s.bullets, accent));
    add(`ppt/slides/_rels/slide${i + 1}.xml.rels`, XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
      "</Relationships>");
  });

  add("ppt/slideLayouts/slideLayout1.xml", XML + `<p:sldLayout xmlns:a="${NS_A}" xmlns:p="${NS_P}" xmlns:r="${NS_R}" type="blank" preserve="1">` +
    `<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>');
  add("ppt/slideLayouts/_rels/slideLayout1.xml.rels", XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>');

  add("ppt/slideMasters/slideMaster1.xml", XML + `<p:sldMaster xmlns:a="${NS_A}" xmlns:p="${NS_P}" xmlns:r="${NS_R}">` +
    `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>` +
    `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
    `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`);
  add("ppt/slideMasters/_rels/slideMaster1.xml.rels", XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>');

  add("ppt/theme/theme1.xml", XML + `<a:theme xmlns:a="${NS_A}" name="Dove">` +
    `<a:themeElements><a:clrScheme name="Dove"><a:dk1><a:srgbClr val="1F1C18"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>` +
    `<a:dk2><a:srgbClr val="33302B"/></a:dk2><a:lt2><a:srgbClr val="FAF7F2"/></a:lt2>` +
    `<a:accent1><a:srgbClr val="${accent}"/></a:accent1><a:accent2><a:srgbClr val="8A5A3B"/></a:accent2>` +
    `<a:accent3><a:srgbClr val="3B4A63"/></a:accent3><a:accent4><a:srgbClr val="6B5B4A"/></a:accent4>` +
    `<a:accent5><a:srgbClr val="42564D"/></a:accent5><a:accent6><a:srgbClr val="A8443A"/></a:accent6>` +
    `<a:hlink><a:srgbClr val="2F5D50"/></a:hlink><a:folHlink><a:srgbClr val="7A7267"/></a:folHlink></a:clrScheme>` +
    `<a:fontScheme name="Dove"><a:majorFont><a:latin typeface="Helvetica"/><a:ea typeface="PingFang SC"/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="Helvetica"/><a:ea typeface="PingFang SC"/></a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="Dove"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
    `<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>` +
    `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
    `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements>` +
    `<a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`);

  return zip(entries);
}

export const generatePptTool = defineTool({
  name: "GeneratePPT",
  discoverable: "生成 .pptx 演示文稿",
  description: [
    "根据大纲生成一个 .pptx 演示文稿，保存到项目的 outputs/ 目录。",
    "每页 = 一个标题 + 3–5 条要点。要点写短句，不要整段文字。",
    "生成后把文件路径告诉用户。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "演示文稿标题（用作文件名与封面）" },
      subtitle: { type: "string", description: "副标题（可选）" },
      slides: {
        type: "array",
        description: "幻灯片列表",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "本页标题" },
            bullets: { type: "array", items: { type: "string" }, description: "本页要点" },
          },
          required: ["title"],
        },
      },
      accent_color: { type: "string", description: "主色，6 位十六进制（不带 #），默认 2F5D50" },
      filename: { type: "string", description: "文件名（可选，不用带扩展名）" },
    },
    required: ["title", "slides"],
  },
  outputTier: "exact",
  approval: "never",
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    const title = str(input, "title");
    const raw = Array.isArray(input.slides) ? input.slides : [];
    if (raw.length === 0) return { error: "slides 不能为空" };
    const slides = raw.slice(0, 60).map((s) => {
      const o = s as { title?: unknown; bullets?: unknown };
      return {
        title: String(o.title ?? ""),
        bullets: (Array.isArray(o.bullets) ? o.bullets : []).map((b) => String(b)).slice(0, 8),
      };
    });
    const subtitle = optStr(input, "subtitle");
    if (subtitle) slides.unshift({ title, bullets: [subtitle] });

    const accent = (/^[0-9a-fA-F]{6}$/.test(String(input.accent_color ?? "")) ? String(input.accent_color) : "2F5D50").toUpperCase();
    const buf = buildPptx(slides, accent);

    const dir = join(ctx.outputsDir);
    mkdirSync(dir, { recursive: true });
    const safe = (optStr(input, "filename") ?? title).replace(/[^\p{L}\p{N}_\- ]/gu, "").trim().slice(0, 60) || "presentation";
    const file = join(dir, safe + ".pptx");
    writeFileSync(file, buf);
    const hash = createHash("sha256").update(buf).digest("hex").slice(0, 12);
    return { ok: true, path: file, slides: slides.length, bytes: buf.length, sha256_prefix: hash, message: `已生成 ${slides.length} 页的 PPT：${file}` };
  }),
});
