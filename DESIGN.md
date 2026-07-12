---
name: SubGen
description: AI-powered video subtitle generation — precision tool for speech recognition and translation.
colors:
  precision-indigo: oklch(65% 0.22 265)
  precision-indigo-hover: oklch(70% 0.22 265)
  precision-indigo-muted: oklch(65% 0.22 265 / 12%)
  precision-indigo-glow: oklch(65% 0.22 265 / 20%)
  instrument-base: oklch(10% 0.012 265)
  panel-raised: oklch(13% 0.014 265)
  panel-elevated: oklch(16% 0.016 265)
  panel-interactive: oklch(20% 0.018 265)
  border-visible: oklch(28% 0.022 265)
  border-subtle: oklch(22% 0.018 265)
  text-primary: oklch(95% 0.008 265)
  text-secondary: oklch(68% 0.018 265)
  text-muted: oklch(48% 0.016 265)
  status-success: oklch(72% 0.16 145)
  status-danger: oklch(65% 0.20 20)
  status-warning: oklch(78% 0.16 75)
typography:
  headline:
    fontFamily: var(--font-sans)
    fontSize: 2.25rem
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  body:
    fontFamily: var(--font-sans)
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: var(--font-sans)
    fontSize: 0.75rem
    fontWeight: 500
    lineHeight: 1.4
  mono:
    fontFamily: var(--font-mono)
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: 6px
  md: 10px
  lg: 16px
  xl: 24px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
components:
  button-primary:
    backgroundColor: "{colors.precision-indigo}"
    textColor: white
    rounded: "{rounded.lg}"
    padding: 14px 24px
  button-primary-hover:
    backgroundColor: "{colors.precision-indigo-hover}"
  button-primary-disabled:
    backgroundColor: "{colors.panel-elevated}"
    textColor: "{colors.text-muted}"
  button-subtle:
    backgroundColor: transparent
    textColor: "{colors.text-muted}"
  input-select:
    backgroundColor: "{colors.panel-elevated}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: 10px 12px
  chip-badge:
    backgroundColor: "{colors.precision-indigo-muted}"
    textColor: "{colors.precision-indigo}"
    rounded: 9999px
    padding: 4px 10px
---

# Design System: SubGen

## 1. Overview

**Creative North Star: "精密仪器"**

SubGen 的界面像一台精密仪器 —— 徕卡相机、示波器、高端音频分析仪。暗色机身让内容成为唯一的焦点，单一靛蓝指示灯传达关键状态，除此之外没有多余的装饰。这不是冷淡；这是一种专业工具的自律：它知道自己是手段而非目的。

品牌个性「精准、高效、可靠」通过三种方式落地到视觉：(1) 纯色分层代替繁复装饰，层次由亮度差定义；(2) 靛蓝强调色只出现在功能节点 —— 选中状态、主操作、进度指示、完成信号；(3) 排版克制，只用粗细和大小两层对比，没有花哨的字重堆叠。

系统明确拒绝「AI 魔盒」风格：没有霓虹渐变、没有粒子背景、没有网格线网。暗色在这里是功能选择（减少视觉噪音、突出内容），不是酷炫贴纸。

**Key Characteristics:**

- 单色强调体系：一个靛蓝，四个 opacities，覆盖全部交互状态
- 纯色纵深：4 层 surface 亮度差（10% → 20%），无阴影分层
- 微阴影仅在最高层级（tooltip、悬浮面板）出场
- OKLCH 全链路 —— 暗色下 chroma 压至 0.008–0.022，避免过饱和
- 组件触感「柔软克制」：圆角居中但不圆润（6–16px），过渡 150–200ms ease-out

## 2. Colors

靛蓝单色强调 + 微偏色中性灰。所有中性色都向靛蓝方向偏移 chroma 0.005–0.022，避免纯灰在暗色下的「脏」感。

### Primary

- **Precision Indigo** (`oklch(65% 0.22 265)`): 唯一强调色。主按钮、选中态、进度点、完成信号。仅出现在 ~10% 的屏幕面积上；稀少即是其力量。
- **Precision Indigo Hover** (`oklch(70% 0.22 265)`): 悬停态，亮度 +5%。
- **Precision Indigo Muted** (`oklch(65% 0.22 265 / 12%)`): 强调区域背景（统计数据条、badge）。
- **Precision Indigo Glow** (`oklch(65% 0.22 265 / 20%)`): 主按钮的外发光，仅当按钮处于 active 态。

### Neutral

- **Instrument Base** (`oklch(10% 0.012 265)`): 页面底色。最低亮度，最高视觉退让。
- **Panel Raised** (`oklch(13% 0.014 265)`): 卡片、选项面板。第一层浮起。
- **Panel Elevated** (`oklch(16% 0.016 265)`): 交互态表面、输入框背景、hover 高亮。
- **Panel Interactive** (`oklch(20% 0.018 265)`): 按钮/输入框的 active/pressed 状态。
- **Border Visible** (`oklch(28% 0.022 265)`): 可见边框和分割线。
- **Border Subtle** (`oklch(22% 0.018 265)`): 弱分割，面板内区域分隔。

### Semantic

- **Status Success** (`oklch(72% 0.16 145)`): 成功 / 完成状态。
- **Status Danger** (`oklch(65% 0.20 20)`): 错误状态。
- **Status Warning** (`oklch(78% 0.16 75)`): 警告状态（仅用于文件过大提示）。

### Named Rules

**The Single Accent Rule.** Precision Indigo 是唯一强调色。禁止引入第二个强调色或调整其 hue。所有交互状态通过亮度（+5%）和透明度（12%/20%）派生，不新建颜色。

**The Tinted Neutral Rule.** 所有中性色必须向 Precision Indigo 的 hue（265）偏移至少 chroma 0.005。纯灰在暗色下看起来脏，永远禁止。

## 3. Typography

**Primary Font:** System font stack (`-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif`)。优先系统原生字体以减少加载开销 —— 工具应用不需要 web font 的个性表达。
**Mono Font:** `"Berkeley Mono", "JetBrains Mono", "Fira Code", ui-monospace`。用于时间码、文件名、技术标签。

**Character:** 安静、中性、不抢戏。排版的任务是传达信息层级，不是表现风格。粗细对比（regular / semibold）是唯一的强调手段。

### Hierarchy

- **Headline** (semibold, 2.25rem, 1.2): 页面主标题。仅出现一次。
- **Body** (regular, 1rem, 1.6): 正文和说明文字。最大行宽 65ch。
- **Secondary** (regular, 0.875rem, 1.5): 辅助信息、按钮文字、列表项。
- **Label** (medium, 0.75rem, 1.4): 表单标签、分类标记、步骤指示。
- **Mono** (regular, 0.8125rem, 1.5): 时间码 `00:01:23,456`、文件名。等宽数字（`tabular-nums`）必须开启。

### Named Rules

**The Two-Weight Rule.** 只用 regular (400) 和 semibold (600)。没有 light、bold、extrabold。层次由大小决定，不由字重堆叠决定。

## 4. Elevation

日常界面完全平铺，通过 4 层 surface 亮度差（10% → 13% → 16% → 20%）传达纵深。背景最暗，内容面板稍亮，交互态再亮一层。

微阴影仅出现在脱离文档流的最高层 —— tooltip、悬浮预览面板、下拉菜单。这些元素的阴影极轻：`0 4px 16px rgba(0,0,0,0.25)`，足够暗示脱离但不会制造强投影的「浮空感」。

### Shadow Vocabulary

- **Subtle Float** (`box-shadow: 0 4px 16px rgba(0,0,0,0.25)`): Tooltip、下拉菜单、悬浮预览面板。仅在 z-index 最高层使用。
- **Accent Glow** (`box-shadow: 0 0 24px var(--color-accent-glow)`): 主按钮 active 态。唯一的功能性发光，指示当前可操作元素。

### Named Rules

**The Flat-By-Default Rule.** 所有 surface 在静止状态下平整。阴影只作为脱离文档流的信号（tooltip、菜单），不作为装饰。如果某个元素没脱离文档流却有阴影，那就是错误。

## 5. Components

### Buttons

- **Shape:** 全圆角 (`--radius-lg`, 16px)。柔软但不圆润。
- **Primary:** Precision Indigo 底色，白色文字，py-3.5（14px 垂直内边距），全宽。Active 态带 Accent Glow 发光。
- **Disabled:** Panel Elevated 底色，text-muted 文字，cursor: not-allowed。无阴影。
- **Hover Transition:** background-color 200ms ease-out。无 transform（精密仪器不飘移）。
- **Ghost:** 透明底色，text-muted 文字，hover 时出现 border-subtle 边框和 panel-raised 底色。

### Chips / Badge

- **Style:** Precision Indigo Muted 底色 + Precision Indigo 文字，`border: 1px solid oklch(65% 0.22 265 / 20%)`。圆角 9999px（胶囊）。
- **Usage:** 「Whisper · DeepL」技术服务标识。纯信息性，不可交互。

### Cards / Panels

- **Corner Style:** `--radius-lg` (16px)。
- **Background:** Panel Raised，border: 1px solid Border Subtle。
- **Internal Padding:** 16px (`p-4`)。
- **No Shadow:** 通过 border 和底色差与背景区分。

### Inputs / Selects

- **Style:** Panel Elevated 底色，Border Subtle 边框，`--radius-md` (10px)，py-2.5 px-3。
- **Focus:** 不实现独立 focus ring（设计系统不支持多强调色），保留浏览器默认 focus-visible。
- **Dropdown Arrow:** 绝对定位右侧，text-muted 色，chevron-down SVG。

### Drop Zone (Signature)

- **Style:** 1.5px dashed border，radius-lg (16px)。空态 padding 36px，已选文件减至 20px。
- **States:** idle（border 色）、dragging（Precision Indigo border + Muted 底色）、file-selected（success 色 border + 5% success 底色）、too-large（warning 色 border + 5% warning 底色）。
- **File Preview:** 左侧 40px 图标位（`--radius-md` 圆角），右侧文件名 + 大小 + 状态 icon。

### Progress Indicator (Signature)

- **Style:** 水平步骤条，圆点 + 标签 + 连接线。Active 圆点带 `pulse-ring` 动画（1.5s ease-in-out 循环），已完成步骤连线变为 Precision Indigo。
- **Motion:** 连线颜色 transition 500ms，圆点 transition 300ms。

### Result Downloads (Signature)

- **Style:** 列表按钮，每行 icon + 主文字 + 副文字 + 下载箭头。hover 时底色从 panel-elevated 升到 panel-interactive，边框从 border-subtle 升到 border-visible。
- **Click Feedback:** 箭头 icon 切换为绿色 checkmark 2 秒后恢复。

## 6. Do's and Don'ts

### Do:

- **Do** 只用 Precision Indigo 一种强调色，通过透明度和亮度派生所有状态变体
- **Do** 用 surface 层级（0 → 3）的亮度差区分纵深，这是主要的空间语言
- **Do** 保持组件触感柔软克制：圆角 6–16px，过渡 150–200ms ease-out
- **Do** 所有中性色向 hue 265 偏移至少 chroma 0.005 —— 纯灰在暗色下禁用
- **Do** 排版只用 regular 和 semibold 两个字重，层次由大小构建

### Don't:

- **Don't** 使用「AI 魔盒」风格元素：霓虹渐变、粒子背景、网格线网、玻璃拟态（glassmorphism）
- **Don't** 引入第二个强调色或将 accent hue 偏离 265。靛蓝是系统的唯一声音
- **Don't** 给静态卡片或面板加阴影。阴影仅用于脱离文档流的元素（tooltip、下拉菜单）
- **Don't** 使用 `#000` 或 `#fff`。最深色是 Instrument Base，最亮色是 text-primary
- **Don't** 在非交互元素上加发光效果。Accent Glow 仅限主按钮 active 态
- **Don't** 给正文加 light 或 bold 字重。Regular 和 semibold 就是全部
