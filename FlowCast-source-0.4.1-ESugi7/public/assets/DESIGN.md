# 图标资源

FlowCast 图标使用两个交织的画面窗口构成连续的环形连接，表达手机与电脑的协作和不中断的录制。主色为深色背景、青柠绿和薄荷青，图形在小尺寸下仍保持清晰。

- `flowcast.svg`：可编辑源文件
- `flowcast-*.png`：应用和网页使用的栅格尺寸
- `flowcast.ico`：Windows 图标
- Android `VectorDrawable`：启动和通知图标

在安装 Chrome 的开发机上运行以下命令可重新生成 PNG 和 ICO：

~~~powershell
npm run build:icons
~~~

也可以通过 `CHROME_PATH` 指定 Chrome 的可执行文件位置。图标由项目内的 SVG 和本地脚本生成，不依赖在线服务。

