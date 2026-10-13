import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 输入框左下角的**模式药丸** —— 「这一轮带着哪个模式」的可视可点版本。
 *
 * 视觉照 mnemo 的 .mode-chip / .mode-chip.on 翻成 Dove 的令牌：
 *   胶囊（rounded-full）、1px 描边、12px 字、中性灰的底和字；
 *   「开着」= 描边染主题色（mnemo 的 color-mix(accent 50%, line)）+ accent-subtle 底。
 * 和 mnemo 的唯一差别：✕ 常态**不显形**，悬停才浮出来 ——
 * 用 opacity 而不是 hidden/display，免得悬停时整颗药丸宽度跳一下。
 *
 * 纪律和「+」菜单一样：**只做展示，不持有状态**。点了就调 onClear，
 * 关掉的是调用方那份真状态（Swarm 是本地旗标、计划模式是内核的 planMode 位），
 * 绝不另开一份本地变量 —— 否则会出现"模型已经退出计划模式、药丸还亮着"那样的假象。
 */
export interface ModeChipSpec {
  key: string;
  /** 主文案，如「Swarm」 */
  label: string;
  /** 悬停提示；不传就是「<模式名>（点击取消）」 */
  title?: string;
  icon: React.ReactNode;
  /** 点药丸本体或 ✕ —— 都是关掉这个模式 */
  onClear: () => void;
}

export function ModeChip({ chip, className }: { chip: ModeChipSpec; className?: string }) {
  return (
    <button
      type="button"
      title={chip.title ?? `${chip.label}（点击取消）`}
      aria-label={`取消 ${chip.label}`}
      onClick={chip.onClear}
      className={cn(
        "group flex h-7 max-w-[12rem] shrink-0 items-center gap-1 rounded-full border border-accent/50 bg-accent-subtle px-2 text-2xs text-text-primary",
        "transition-colors duration-fast hover:bg-accent-subtle-hover",
        className,
      )}
    >
      <span className="flex size-3 shrink-0 items-center justify-center">{chip.icon}</span>
      <span className="truncate">{chip.label}</span>
      <X
        aria-hidden
        className="size-3 shrink-0 opacity-0 transition-opacity duration-fast group-hover:opacity-100"
      />
    </button>
  );
}

/**
 * 一组药丸（没装备模式时整组不渲染，不留空隙）。
 * 以后加模式就往调用方的表里追一条，别在这里写死 —— 见 ChatPanel 的 modeChips。
 */
export function ModeChips({ chips, className }: { chips: ModeChipSpec[]; className?: string }) {
  if (chips.length === 0) return null;
  return (
    <>
      {chips.map((chip) => (
        <ModeChip key={chip.key} chip={chip} className={className} />
      ))}
    </>
  );
}
