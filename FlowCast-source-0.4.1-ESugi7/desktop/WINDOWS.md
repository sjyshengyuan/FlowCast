# Windows 桌面版

## 安装和启动

如果仓库 Releases 已提供安装包，下载 `FlowCast-Setup-<version>-x64.exe`，按向导安装后从开始菜单或桌面启动。免安装版本解压完整 ZIP 后运行 `FlowCast.exe`；不要只复制 exe 文件。

桌面版会自动启动工作台、选择空闲端口并复用已有窗口。用户不需要安装 Node.js，也不需要手动输入端口。Windows 可能因为程序未签名而显示未知发布者提示。

## 手机配对

打开桌面工作台中的最新二维码，在手机端选择“扫描电脑二维码”。局域网模式要求两台设备位于同一 Wi-Fi 或热点。更换网络后请重新生成并扫描二维码。跨网络使用需要先在电脑端配置远程信令服务，说明见 [remote/README.md](../remote/README.md)。

桌面端的证书和配对记录保存在当前 Windows 用户的应用数据目录，录像保存在系统“视频/FlowCast”目录。卸载程序不会自动删除这些数据。

## 构建

~~~powershell
npm install
npm run pack:win
npm run dist:win
~~~

`pack:win` 生成展开目录，`dist:win` 生成安装程序和 ZIP。构建文件位于 `dist/`，不应提交到源代码仓库。

## 验证

~~~powershell
npm run test:desktop
npm run test:desktop:packaged
~~~

自动化验收覆盖窗口启动、单实例、端口释放、配对隔离、模拟媒体、录制分片和退出流程。真实摄像头、真实手机和安装向导仍应在目标 Windows 版本上手动验证。
