/**
 * 项目管理：工作区、端口、模板
 */
import { existsSync, mkdirSync, cpSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import type { Store } from "../session/store.ts";
import { buildProject } from "./build.ts";
import { VersionManager } from "./version.ts";
import type { ProjectOps } from "../tools/types.ts";
import type { PreviewManager } from "./preview.ts";

export interface ProjectRecord { id: string; name: string; path: string; port?: number; kind: string }

export class ProjectManager {
  #store: Store;
  #versions = new VersionManager();
  #preview: PreviewManager | null;
  #workspaceRoot: string;
  #templateDir: string | null;

  constructor(opts: { store: Store; workspaceRoot: string; templateDir?: string; preview?: PreviewManager }) {
    this.#store = opts.store;
    this.#workspaceRoot = resolve(opts.workspaceRoot);
    this.#templateDir = opts.templateDir ?? null;
    this.#preview = opts.preview ?? null;
    if (!existsSync(this.#workspaceRoot)) mkdirSync(this.#workspaceRoot, { recursive: true });
  }

  get workspaceRoot(): string { return this.#workspaceRoot; }

  list(): ProjectRecord[] { return this.#store.listProjects(); }
  get(id: string): ProjectRecord | undefined { return this.#store.getProject(id); }

  /** 分配端口：3000 起，跳过已用 */
  #allocPort(): number {
    const used = new Set(this.list().map((p) => p.port).filter(Boolean) as number[]);
    for (let p = 3000; p < 3100; p++) if (!used.has(p)) return p;
    return 3099;
  }

  create(opts: { id?: string; name: string; template?: string }): ProjectRecord {
    const id = opts.id ?? `p${Date.now().toString(36)}`;
    const dir = join(this.#workspaceRoot, id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const tpl = opts.template ?? this.#templateDir;
    if (tpl && existsSync(tpl)) {
      cpSync(tpl, dir, { recursive: true, filter: (src) => !src.includes("node_modules") && !src.includes("/.git/") });
    }

    const rec: ProjectRecord = { id, name: opts.name, path: dir, port: this.#allocPort(), kind: "website" };
    this.#store.upsertProject(rec);
    return rec;
  }

  /**
   * 从注册表里移除项目。
   * 注意：**只解绑，不删磁盘文件** —— 用户的项目目录比注册表重要得多，
   * 删错了没法恢复。要清磁盘请用户自己确认后手动删。
   */
  remove(id: string): boolean {
    if (!this.get(id)) return false;
    this.#store.removeProject(id);
    return true;
  }

  /** 给工具用的 ProjectOps（T5.5） */
  ops(id: string): ProjectOps {
    const rec = this.get(id);
    if (!rec) throw new Error(`项目 ${id} 不存在`);
    const self = this;
    return {
      async build() { return buildProject(rec.path); },
      async preview() {
        if (!self.#preview) return { url: "", port: rec.port ?? 0 };
        return self.#preview.start(rec.id, rec.path);
      },
      async listVersions() {
        const vs = await self.#versions.list(rec.path);
        return vs.map((v) => ({ version: v.version, message: v.message, at: v.at }));
      },
      async restoreVersion(version: string) { return self.#versions.restore(rec.path, version); },
      async snapshot(message: string) {
        const r = await self.#versions.snapshot(rec.path, message);
        return { ok: r.ok, version: r.version, message: r.message };
      },
    };
  }

  /** 起开发服务器 / 静态预览（老契约的 /api/projects/{port}/start 用） */
  async startPreview(id: string): Promise<{ url: string; port: number } | null> {
    const rec = this.get(id);
    if (!rec || !this.#preview) return null;
    return this.#preview.start(rec.id, rec.path);
  }

  /** 停开发服务器（老契约的 /stop 与 /restart 用） */
  stopPreview(id: string): void {
    try { this.#preview?.stop(id); } catch { /* ignore */ }
  }

  versions(id: string) { const r = this.get(id); return r ? this.#versions.list(r.path) : Promise.resolve([]); }
  snapshot(id: string, message: string) { const r = this.get(id); return r ? this.#versions.snapshot(r.path, message) : Promise.resolve({ ok: false, message: "项目不存在" }); }
  restore(id: string, version: string) { const r = this.get(id); return r ? this.#versions.restore(r.path, version) : Promise.resolve({ ok: false, message: "项目不存在" }); }

  /** 文件树（面板用） */
  tree(id: string, maxDepth = 4): unknown {
    const rec = this.get(id);
    if (!rec) return null;
    const HIDE = new Set(["node_modules", ".git", "dist", ".logs", ".spill"]);
    const walk = (dir: string, depth: number): unknown[] => {
      if (depth > maxDepth) return [];
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return []; }
      const out: unknown[] = [];
      for (const e of entries.sort()) {
        if (HIDE.has(e)) continue;
        const full = join(dir, e);
        let st; try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) out.push({ name: e, type: "dir", children: walk(full, depth + 1) });
        else out.push({ name: e, type: "file", size: st.size });
      }
      return out;
    };
    return { id: rec.id, name: rec.name, children: walk(rec.path, 0) };
  }

  /** 路径安全：只允许在项目目录内 */
  resolveInside(id: string, p: string): string | null {
    const rec = this.get(id);
    if (!rec) return null;
    const abs = resolve(rec.path, p);
    const rel = relative(rec.path, abs);
    if (rel.startsWith("..") || resolve(abs) === resolve("/")) return null;
    return abs;
  }
}
