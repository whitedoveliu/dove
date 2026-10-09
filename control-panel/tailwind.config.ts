import type { Config } from "tailwindcss";

/**
 * Aperture Design System — Tailwind bridge.
 *
 * Every value here reads from a CSS custom property declared in
 * app/globals.css, so the whole product re-themes from one place and
 * components never hard-code a colour, radius, shadow or duration.
 *
 *   primitive ramp  ->  semantic token  ->  utility class
 *   --iris-600      ->  --accent        ->  bg-accent
 */
const token = (name: string) => "rgb(var(" + name + ") / <alpha-value>)";
/** For tokens whose value is a complete colour (e.g. color-mix()), not components. */
const raw = (name: string) => "var(" + name + ")";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        /* ---------- shadcn-compatible names (kept for compatibility) ------- */
        /* 边框统一走 --border-rgb（三分量），透明度写死在这里：
           之前把令牌写成 rgba() 再套 rgb(var()/<alpha>) 会产出非法 CSS，
           浏览器回退成 currentColor → 就是那些"黑框"。 */
        border: {
          DEFAULT: "rgb(var(--border-rgb) / 0.07)",
          default: "rgb(var(--border-rgb) / 0.07)",
          subtle: "rgb(var(--border-rgb) / 0.04)",
          strong: "rgb(var(--border-rgb) / 0.12)",
        },
        input: "rgb(var(--border-rgb) / 0.07)",
        ring: token("--ring"),
        background: token("--background"),
        foreground: token("--foreground"),

        /* ---------- surfaces (the elevation ladder) ------------------------ */
        surface: {
          app: token("--surface-app"),
          sunken: token("--surface-sunken"),
          raised: token("--surface-raised"),
          overlay: token("--surface-overlay"),
          inset: token("--surface-inset"),
          hover: raw("--surface-hover"),
          active: raw("--surface-active"),
          selected: token("--surface-selected"),
          scrim: token("--surface-scrim"),
          glass: token("--surface-glass"),
        },

        /* ---------- content ------------------------------------------------- */
        text: {
          primary: token("--text-primary"),
          secondary: token("--text-secondary"),
          tertiary: token("--text-tertiary"),
          disabled: token("--text-disabled"),
          inverse: token("--text-inverse"),
          accent: token("--text-accent"),
        },

        /* ---------- brand accent -------------------------------------------- */
        accent: {
          DEFAULT: token("--accent"),
          hover: token("--accent-hover"),
          active: token("--accent-active"),
          fg: token("--accent-fg"),
          foreground: token("--accent-foreground"),
          subtle: token("--accent-subtle"),
          "subtle-hover": token("--accent-subtle-hover"),
          "subtle-fg": token("--accent-subtle-fg"),
          border: token("--accent-border"),
          ring: token("--accent-ring"),
        },

        /* ---------- thinking（Codex 的 ANSI magenta 用法）-------------------- */
        thinking: {
          DEFAULT: token("--thinking"),
          subtle: token("--thinking-subtle"),
          fg: token("--thinking-fg"),
        },

        /* ---------- status -------------------------------------------------- */
        success: {
          DEFAULT: token("--success"),
          subtle: token("--success-subtle"),
          fg: token("--success-fg"),
          foreground: token("--success-fg"),
        },
        warning: {
          DEFAULT: token("--warning"),
          subtle: token("--warning-subtle"),
          fg: token("--warning-fg"),
          foreground: token("--warning-fg"),
        },
        info: {
          DEFAULT: token("--info"),
          subtle: token("--info-subtle"),
          fg: token("--info-fg"),
          foreground: token("--info-fg"),
        },
        danger: {
          DEFAULT: token("--danger"),
          hover: token("--danger-hover"),
          subtle: token("--danger-subtle"),
          fg: token("--danger-fg"),
        },
        destructive: {
          DEFAULT: token("--destructive"),
          foreground: token("--destructive-foreground"),
        },

        /* ---------- shadcn composites --------------------------------------- */
        primary: {
          DEFAULT: token("--primary"),
          foreground: token("--primary-foreground"),
          hover: token("--accent-hover"),
        },
        secondary: {
          DEFAULT: token("--secondary"),
          foreground: token("--secondary-foreground"),
        },
        muted: {
          DEFAULT: token("--muted"),
          foreground: token("--muted-foreground"),
        },
        card: {
          DEFAULT: token("--card"),
          foreground: token("--card-foreground"),
        },
        popover: {
          DEFAULT: token("--popover"),
          foreground: token("--popover-foreground"),
        },
      },

      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },

      /* Type scale（对齐 DSH：正文 14/24，标题 21/19/18，代码 12/19） */
      fontSize: {
        "2xs": ["11px", { lineHeight: "16px" }],
        xs: ["12px", { lineHeight: "18px" }],
        sm: ["13px", { lineHeight: "20px" }],
        base: ["14px", { lineHeight: "24px" }],
        md: ["15px", { lineHeight: "24px" }],
        lg: ["18px", { lineHeight: "26px", letterSpacing: "-0.01em" }],
        xl: ["19px", { lineHeight: "28px", letterSpacing: "-0.01em" }],
        "2xl": ["21px", { lineHeight: "30px", letterSpacing: "-0.01em" }],
        "3xl": ["24px", { lineHeight: "32px", letterSpacing: "-0.015em" }],
        "4xl": ["30px", { lineHeight: "38px", letterSpacing: "-0.02em" }],
      },

      borderRadius: {
        xs: "var(--radius-xs)",
        sm: "var(--radius-sm)",
        DEFAULT: "var(--radius-md)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        "2xl": "var(--radius-2xl)",
        "3xl": "var(--radius-3xl)",
      },

      boxShadow: {
        xs: "var(--shadow-xs)",
        sm: "var(--shadow-sm)",
        DEFAULT: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        xl: "var(--shadow-xl)",
        inset: "var(--shadow-inset)",
        focus: "var(--shadow-focus)",
        accent: "var(--shadow-accent)",
      },

      spacing: {
        sidebar: "var(--sidebar-width)",
        rail: "var(--sidebar-rail-width)",
        chat: "var(--chat-width)",
        "4.5": "1.125rem",
        "13": "3.25rem",
        "15": "3.75rem",
      },

      zIndex: {
        base: "var(--z-base)",
        raised: "var(--z-raised)",
        sticky: "var(--z-sticky)",
        overlay: "var(--z-overlay)",
        modal: "var(--z-modal)",
        popover: "var(--z-popover)",
        toast: "var(--z-toast)",
        tooltip: "var(--z-tooltip)",
      },

      transitionTimingFunction: {
        standard: "var(--ease-standard)",
        emphasized: "var(--ease-emphasized)",
        exit: "var(--ease-exit)",
        spring: "var(--ease-spring)",
      },

      transitionDuration: {
        instant: "var(--duration-instant)",
        fast: "var(--duration-fast)",
        normal: "var(--duration-normal)",
        slow: "var(--duration-slow)",
        slower: "var(--duration-slower)",
      },

      backdropBlur: {
        xs: "2px",
      },

      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "fade-out": {
          from: { opacity: "1" },
          to: { opacity: "0" },
        },
        "pop-in": {
          from: { opacity: "0", transform: "scale(0.96) translateY(2px)" },
          to: { opacity: "1", transform: "scale(1) translateY(0)" },
        },
        "pop-out": {
          from: { opacity: "1", transform: "scale(1)" },
          to: { opacity: "0", transform: "scale(0.97)" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-down": {
          from: { opacity: "0", transform: "translateY(-6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(8px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "slide-in-left": {
          from: { opacity: "0", transform: "translateX(-8px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.45" },
        },
        "caret-blink": {
          "0%, 70%, 100%": { opacity: "1" },
          "20%, 50%": { opacity: "0" },
        },
        indeterminate: {
          "0%": { transform: "translateX(-100%) scaleX(0.4)" },
          "50%": { transform: "translateX(20%) scaleX(0.7)" },
          "100%": { transform: "translateX(120%) scaleX(0.4)" },
        },
      },

      animation: {
        "fade-in": "fade-in var(--duration-normal) var(--ease-standard)",
        "fade-out": "fade-out var(--duration-fast) var(--ease-exit)",
        "pop-in": "pop-in var(--duration-fast) var(--ease-emphasized)",
        "pop-out": "pop-out var(--duration-instant) var(--ease-exit)",
        "slide-up": "slide-up var(--duration-normal) var(--ease-emphasized)",
        "slide-down": "slide-down var(--duration-normal) var(--ease-emphasized)",
        "slide-in-right": "slide-in-right var(--duration-normal) var(--ease-emphasized)",
        "slide-in-left": "slide-in-left var(--duration-normal) var(--ease-emphasized)",
        shimmer: "shimmer 2.5s linear infinite",
        "pulse-soft": "pulse-soft 2s var(--ease-standard) infinite",
        "caret-blink": "caret-blink 1.1s steps(1) infinite",
        indeterminate: "indeterminate 1.4s var(--ease-standard) infinite",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};

export default config;
