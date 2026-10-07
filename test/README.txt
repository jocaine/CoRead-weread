test —— AI 的操作区 / 开发期数据（不进发行包）
====================================================================

这一格收**所有"非正式、过程性"的文件**：judge / 图谱那套离线脚本的输入与产物、
临时脚本、诊断输出、截图、审计中间件、一次性数据抽取。

**用户明确表示不查看这一格** —— 看到 `test\` 就知道是 AI 操作留下的东西。

规矩原文见仓库根 `AGENTS.md` 第 7 条。


⚠️ 这一格里有作者本人的真实阅读数据，不是测试夹具
--------------------------------------------------------------------
`judge-real-*`、`knowledge-graph-results.json`、`xuezuogong-rebuilt-discussions.json` 这些
**都是作者本人的真实阅读数据**（真实的提问、判定的结果、读《静静的顿河》与《学做工》
积累的会意图谱）。所以三条规矩：**不入 git、不进发行包、不要发给别人。**

另注：名字叫 test **不代表**它是测试夹具 —— 它和 `agent\test\`、`extension\test\`、
`.selftest\` 那三个**正式测试目录**完全不是一回事（那三个是入库的代码，这一格是不入库的本机数据）。


两层放法（2026-10-07 定规）
--------------------------------------------------------------------
    test\            跑批脚本按固定文件名读写的产物（就是本文件下面列的那些）。路径是约定，别挪。
    test\scratch\    其它一切临时东西。按需新建，随便放，不用起好名字。

这一格**整个不进 git、不进发行包**（`.gitignore` 排除 `test/*`，只有这份 README 例外），
所以放在这里的东西不需要"能不能删"的判断成本 —— 这也是它存在的意义之一。


为什么必须离开打包源目录（2026-10）
--------------------------------------------------------------------
这些文件原本放在 `agent/scripts/data/`，也就是**打包源目录的隔壁**。那意味着
"打包时把 agent\scripts\ 整个拷进去"这种手滑会把私人数据一起寄给用户 ——
这不是假设，真发生过：作者的读书会意图谱（55 节点 / 27 边）被本地打包带进了发行包，
而 CI 打包因为文件不在 git 里反而躲过了，两边行为不一致、极难察觉。

挪出 `agent\scripts\`（先落在仓库根，2026-10-07 改名为 `test\`）之后，`agent\scripts\` 里
只剩已跟踪的代码 —— **整目录拷也安全了**。这比再加三道校验闸门都可靠：
从"靠闸门拦"变成"物理上不在那儿"。


谁在用这些文件
--------------------------------------------------------------------
    npm run extract:real        写 judge-real-cases.json（从聊天库提取真实讨论单元）
    npm run judge:real          读 judge-real-cases.json → 写 judge-real-results.json
    npm run group:discussions   读上面两个 → 按"一次专题化讨论"分组
    npm run graph:derive        读 judge-real-results.json
    npm run graph:real          同上，但打真实模型
                                → 写 knowledge-graph-results.json / knowledge-graph-demo.json

    这几个别名定义在 `agent\package.json`，要在 `agent\` 目录下执行才认得。

路径真源：`agent/lib/paths.js` 的 `DEVDATA_DIR`（不要在脚本里另写相对路径）。
目录名是 `test\`、常量名保留 `DEVDATA_DIR` —— 前者服务于查看习惯，后者描述语义。


每个文件是什么
--------------------------------------------------------------------
    judge-real-cases.json                     从聊天流提取的"真实讨论单元"，可复现的固定输入
    judge-real-results.json                   判专题化（AI-016）的结果
    judge-real-results.with-xuezuogong.json   合并《学做工》之后的版本
    knowledge-graph-results.json              离线固化出来的会意图谱
                                              （**就是当年被误打进发行包的那一份**）
    knowledge-graph-demo.json                 同一套流程的演示产物
                                              （字段里有 simulation / demoOnly，是模拟输入）
    xuezuogong-rebuilt-discussions.json       《学做工》那批讨论的重建记录
    _l3_sample.txt                            L3 上下文组装的一个采样文本

2026-10-07 清掉了 11 个纯冗余件（7 份旧快照 `.bak*`、4 个跑批日志 `*_run.log`，共 2.3 MB）：
它们都是同一批数据的旧副本，删掉不损失信息。**剩下的每一份都"再生不出来"** ——
`judge-real-results.json` 是当时那版模型跑出来的一次全量测量，今天重跑数字不会一样；
`knowledge-graph-results.json` 由它派生，同理。


删了会怎样
--------------------------------------------------------------------
    不影响程序运行 —— 只有开发期的这几个脚本读它们，运行时数据全在 `data\` 下。

    但 judge / graph 那几个 npm 脚本会因为缺输入而报错。想重跑就先：
        npm run extract:real        # 从 data\sessions\chat.db 重新生成 judge-real-cases.json
    至于 knowledge-graph-results.json，那是历史产物，删了就得重新固化才能再得到；
    想留就先复制一份。
