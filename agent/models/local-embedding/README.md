# 本地会意检索模型

开发目录首次使用时，在仓库根目录运行 `node agent/scripts/prepare-local-embedding.mjs`，再双击 `Start-CoRead.vbs`。准备命令下载固定版本的模型和运行组件。Windows 便携包在打包时完成这一步。

本目录里的 `bge-small-zh-v1.5` 存模型文件，`node_modules` 存运行组件。CoRead 把从用户图谱算出来的匹配数据存到 `data/runtime/graph-vectors.json`。

模型来自 [BAAI](https://huggingface.co/BAAI/bge-small-zh-v1.5)，本目录使用 [Xenova 转换的 8 位版本](https://huggingface.co/Xenova/bge-small-zh-v1.5/tree/75c43b069aac4d136ba6bc1122f995fedcfd2781/onnx)。
