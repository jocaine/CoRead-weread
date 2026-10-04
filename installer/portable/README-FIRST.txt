CoRead —— 一分钟上手
============================================================

【放哪里】很重要，先看这条

  不要把整个文件夹放进 C:\Program Files！
  那里受系统保护，程序写不进自己的数据，会启动失败。

  放到这些地方都可以：
      D:\CoRead
      C:\Users\你的用户名\CoRead
      桌面、文档、其他盘的普通文件夹

  （已经在 Program Files 里了？整包剪切出来就行。）


【怎么用】三步

  第 1 步  双击  01-START-CoRead.bat

           右下角托盘会出现一个图标。右键它可以：
             打开微信读书 / 打开数据文件夹 / 退出 CoRead

  第 2 步  装浏览器插件

           浏览器地址栏输入，回车：  chrome://extensions/
           （Edge 用 edge://extensions/）

           ① 打开右上角「开发者模式」
           ② 点「加载已解压的扩展程序」
           ③ 选中本文件夹里的  extension  目录   ← 就是旁边那个

  第 3 步  填模型 API Key

           打开微信读书网页版，右侧会出现 CoRead 侧栏。
           点侧栏右上角「⋯」→「模型 API 配置」，填入 API 地址、
           API Key、模型名，保存即生效。


【你的数据在哪】

  在  internal  文件夹里（托盘右键「打开数据文件夹」可直接跳过去）：

      internal\agent\data\       阅读画像、知识图谱、API 配置
      internal\receiver\inbox\   聊天记录、标注
      internal\receiver\books\   书库缓存（你读过的章节原文）
      internal\receiver\toolbox\ 翻译记录

  备份：把整个程序文件夹复制一份，就是完整备份。
  搬家：整个文件夹拷到新电脑，记录跟着走。
  彻底删除：先退出 CoRead，再删掉整个程序文件夹。


【出问题了】

  看到"无法验证发布者"的安全警告
      → 双击 internal\unblock.bat，之后不再弹。

  杀毒软件报警（火绒/360/Defender）
      → 误报。本程序没买数字签名证书。在弹窗里选「允许」并记住；
        火绒可以把它加进「信任区」。原因和自查方法见详细说明。

  双击后托盘没出现图标
      → 打开 logs\ 看日志；或先跑 internal\stop.bat 再重试
        （常见原因是端口被上一份没关干净的进程占着）。

  更详细的排查：internal\instructions-zh.txt


【其他文件】

  internal\     程序本体（Node 运行环境、引擎、接收端、你的数据、说明书）
                想核对程序做了什么可以放心看——里面的代码都是可读的
                纯文本 JavaScript，没有编译过的二进制。

  logs\         运行日志，只在排查问题时才需要看。
