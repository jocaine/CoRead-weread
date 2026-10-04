# 第三方来源

## pdfjs-dist（阅读器）

- 来源：npm `pdfjs-dist`
- 版本：**6.3.289**
- 许可证：Apache-2.0，Copyright 2024 Mozilla Foundation
- 使用方式：**直接内置**（非改写），文件在 `vendor/pdfjs/`

| 文件 | 用途 |
|---|---|
| `vendor/pdfjs/pdf.min.mjs` | 渲染 PDF 与解析文字层 |
| `vendor/pdfjs/pdf.worker.min.mjs` | 解析 worker，必须与主库同版本 |
| `vendor/pdfjs/text-layer.css` | 从官方 `web/pdf_viewer.css` 摘出的文字层规则（手抄精简） |
| `vendor/pdfjs/LICENSE` | Apache-2.0 全文 |

选用理由：它自带**文字层**（正文以真实文字节点覆盖在画布上），这样 CoRead 自己的阅读器里
划词、`Range` 高亮、按字符偏移做锚点才成立 —— 也是"不再受微信读书画布书摆布"的前提。
升级与注意见 `vendor/pdfjs/README.md`。

## bssm-oss/img-to-translate

翻译能力的四个文件（`translate-protocol.js`、`translate-background.js`、`translate-overlay.js`、`translate-overlay.css`）原本是一个独立的扩展 `screenshot-translate/`，现已并入 CoRead 扩展。下表的移植关系对该部分有效。

- 仓库：https://github.com/bssm-oss/img-to-translate
- 许可证：MIT，Copyright (c) 2026 bssm-oss
- 使用方式：移植并改写，非直接依赖

### 移植的部分

| 来源文件 | 移植内容 |
|---|---|
| `content.js` | 全屏遮罩加拖拽选区的交互流程；`cropImage()` 按 `图片宽度 / 视口宽度` 计算设备像素倍率后裁剪的算法 |
| `content.js` | 气泡的结构与交互：标题栏拖拽、加载态、原文与译文对照、原文可编辑后防抖重译 |
| `content.css` | 气泡与选区的视觉样式（在新文件中重写，类名前缀改为 `st-`） |
| `background.js` | 「隐藏遮罩 → 截图 → 裁剪 → 请求模型 → 回填气泡」的管线顺序 |

### 改写的部分

| 改动 | 原因 |
|---|---|
| 遮罩与气泡移入闭合 Shadow DOM | 原实现用类名前缀隔离样式，宿主页面的 CSS 重置仍能影响工具 UI |
| 删除 tesseract.js 与全部本地 OCR 管线 | 翻译改由多模态模型直读图片，不需要先识别文字 |
| 删除 Google `translate_a/single` 免费端点 | 该端点非官方，随时限流；改为用户自备的 OpenAI 兼容接口 |
| 移除 `tesseract/` 目录与 `web_accessible_resources` 里的相关条目 | 同上 |
| 译文改用 `textContent` 渲染 | 原实现只转义了原文，译文直接进 `innerHTML`，存在注入 |
| 入口由 window 级按键监听改为 `chrome.commands` | 原方案要求 content script 常驻 `<all_urls>`，会带来「读取所有网站数据」的权限警告 |
| 增加 Esc 与右键取消框选 | 原实现只能靠松开修饰键退出 |
| 气泡关闭时移除拖拽监听 | 原实现的 `document` 级 `mousemove` / `mouseup` 监听不移除 |
| `chrome.storage.sync` 改为 `chrome.storage.local` | 配置含 API Key，不需要跨设备同步 |
| 默认语言由韩语改为简体中文 | 原项目面向韩语用户 |

### 原项目许可证

```
MIT License

Copyright (c) 2026 bssm-oss

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 未采用的候选

调研过但未使用的项目，记录在此避免重复评估：

- `licon/ez-translate`：许可证为自定义非商业条款（GitHub 识别为 NOASSERTION），不能并入 MIT 项目。它也没有 OCR 引擎，截图靠把图交给视觉模型。
- `immersive-translate/immersive-translate`：仓库内只有构建产物 `dist/`，没有源码，GitHub 未识别到许可证。
- `crimx/ext-saladict`：MIT，但仓库内没有截图或 OCR 模块。
- `A9T9/Copyfish`（GPL-2.0）、`Leapward-Koex/Namida-OCR`（GPL-3.0）、`lifthrasiir/loupe`（Apache-2.0，68MB 权重，且无框选功能）。
