# pdf.js（pdfjs-dist）

- 来源：npm `pdfjs-dist`
- 版本：**6.3.289**
- 许可证：Apache-2.0（见同目录 `LICENSE`）
- 用途：在 CoRead 自建阅读器里渲染 PDF，并提供**文字层**（正文以真实文字节点覆盖在画布上）

## 文件

| 文件 | 来源 | 说明 |
|---|---|---|
| `pdf.min.mjs` | `build/pdf.min.mjs` | 主库，ESM |
| `pdf.worker.min.mjs` | `build/pdf.worker.min.mjs` | 解析 worker，必须与主库同版本 |
| `text-layer.css` | 从 `web/pdf_viewer.css` 摘出文字层相关规则 | 手抄精简版，只保留 `.textLayer` 部分 |
| `wasm/` | `wasm/` | JBIG2 / JPEG2000 图像解码、色彩管理、PDF 内嵌 JS |
| `standard_fonts/` | `standard_fonts/` | 未内嵌的标准字体（Helvetica 等） |
| `cmaps/` | `cmaps/` | 中日韩文字的 CID 映射 |
| `iccs/` | `iccs/` | 色彩描述文件 |
| `LICENSE` | 包根目录 | Apache-2.0 全文 |

**`wasm/`、`standard_fonts/`、`cmaps/`、`iccs/` 不能省。** 缺了**不会报错**，只会让某些 PDF
渲染成**空白页** —— 扫描件（JBIG2 / JPEG2000 图像）、没内嵌字体或含中日韩正文的 PDF 首当其冲。
自己手写的简单 PDF 一切正常，所以这个坑在自测里几乎撞不上，只有真实文件进来才暴露。

在 `reader.js` 里通过 `getDocument({ cMapUrl, cMapPacked, standardFontDataUrl, wasmUrl, iccUrl })`
指过来。`image_decoders/` 不需要（v6 的图像解码已经在 wasm 里）。

## 升级方式

```bash
npm pack pdfjs-dist@<版本> --cache ./.vendor-tmp/cache
tar -xzf pdfjs-dist-<版本>.tgz
# 覆盖 build/pdf.min.mjs、build/pdf.worker.min.mjs、LICENSE
# 整目录覆盖 wasm/、standard_fonts/、cmaps/、iccs/
# 再从 web/pdf_viewer.css 里摘一次 .textLayer 规则
```

主库与 worker 必须是同一版本，不能只换其中一个。

## 用到的 API

- `getDocument({ data, ...资源路径 })` → `PDFDocumentProxy`
- `page.getViewport({ scale })` → 视口（含 `width` / `height`）
- `page.render({ canvasContext, viewport, transform })` → 画布（`transform` 用于高分屏倍率）
- `new TextLayer({ textContentSource, container, viewport }).render()` → 文字层
- `textLayer.update({ viewport })` → **缩放时只改尺寸、不重建 DOM**，所以文字节点上的 Range 与高亮不会因为缩放而失效

## 注意

文字层的定位依赖容器上的 CSS 变量 `--total-scale-factor`（等于 `viewport.scale`）。少了这个变量，文字会全部叠在左上角 —— 排查文字层错位先看它。
