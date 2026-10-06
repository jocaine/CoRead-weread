devdata —— 开发期数据（不进发行包）
====================================================================

这一格放的是 judge / 图谱那套离线脚本的输入与产物。

⚠️ 它们**都是作者本人的真实阅读数据**（真实的提问、判定的结果、读《静静的顿河》与
《学做工》积累的会意图谱）。所以三条规矩：**不入 git、不进发行包、不要发给别人。**

为什么单独一格（2026-10）
--------------------------------------------------------------------
这些文件原本放在 `agent/scripts/data/`，也就是**打包源目录的隔壁**。那意味着
"打包时把 agent\scripts\ 整个拷进去"这种手滑会把私人数据一起寄给用户 ——
这不是假设，真发生过：作者的读书会意图谱（55 节点 / 27 边）被本地打包带进了发行包，
而 CI 打包因为文件不在 git 里反而躲过了，两边行为不一致、极难察觉。

挪到仓库根的 `devdata\`（打包白名单永远不会碰的目录）之后，`agent\scripts\` 里
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

路径真源：`agent/lib/paths.js` 的 `DEVDATA_DIR`（不要在脚本里另写相对路径）。


每个文件是什么
--------------------------------------------------------------------
    judge-real-cases.json                     从聊天流提取的"真实讨论单元"，可复现的固定输入
    judge-real-cases.json.bak                 上一版
    judge-real-results.json                   判专题化（AI-016）的结果
    judge-real-results.json.bak               历史版本
    judge-real-results.json.bak2 … .bak5      同一批的多次迭代
    judge-real-results.json.bak-before-xue    合并《学做工》那批之前的快照
    judge-real-results.with-xuezuogong.json   合并《学做工》之后的版本
    knowledge-graph-results.json              离线固化出来的会意图谱
                                              （**就是当年被误打进发行包的那一份**）
    knowledge-graph-demo.json                 同一套流程的演示产物
                                              （字段里有 simulation / demoOnly，是模拟输入）
    xuezuogong-rebuilt-discussions.json       《学做工》那批讨论的重建记录
    *_run.log                                 跑批时的控制台输出
    _l3_sample.txt                            L3 上下文组装的一个采样文本


删了会怎样
--------------------------------------------------------------------
    不影响程序运行 —— 只有开发期的这几个脚本读它们，运行时数据全在 `data\` 下。

    但 judge / graph 那几个 npm 脚本会因为缺输入而报错。想重跑就先：
        npm run extract:real        # 从 data\sessions\chat.db 重新生成 judge-real-cases.json
    至于 knowledge-graph-results.json，那是历史产物，删了就得重新固化才能再得到；
    想留就先复制一份。
