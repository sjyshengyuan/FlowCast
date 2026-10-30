# 开发说明

## 目录

- `server.mjs`：浏览器工作台、HTTPS 和配对服务
- `desktop/`：Electron 主进程、预加载脚本和桌面生命周期
- `public/`：工作台界面、WebRTC、音频和录制逻辑
- `android/`：Android 伴侣应用
- `remote/`：可选的公网信令和 TURN 部署模板
- `tests/`、`scripts/`：自动化测试和开发工具

## 环境

- Node.js 20+
- Windows 桌面开发需要 Electron 45
- Android 构建使用 JDK 17、Gradle 8.13、Android Gradle Plugin 8.13 和 SDK 36
- Android 最低版本为 API 26

依赖安装：

~~~powershell
npm install
~~~

Android 工具链可由 `scripts/setup-android.ps1` 安装，也可以使用 Android Studio 配置相同版本。脚本会从官方地址下载工具，并自动接受 Android SDK 许可；执行前请阅读脚本和相关许可。不希望自动接受时，可在 Android Studio 中自行配置工具链。

使用该脚本配置后，在项目根目录通过本地工具链构建：

~~~powershell
$env:JAVA_HOME = (Get-ChildItem .toolchain/jdk -Directory | Select-Object -First 1).FullName
$env:ANDROID_HOME = (Resolve-Path .toolchain/android-sdk).Path
& ./.toolchain/gradle/gradle-8.13/bin/gradle.bat --no-daemon -p android assembleDebug
~~~

也可使用已配置到 PATH 的 Gradle 8.13 执行 `gradle --no-daemon -p android assembleDebug`。仓库不附带 Gradle Wrapper。默认 APK 输出为 `android/app/build/outputs/apk/debug/app-debug.apk`；调试构建不等于正式签名发布。

## 常用命令

~~~powershell
npm test
npm run desktop
npm run test:desktop
npm run test:desktop:packaged
npm run test:browser
npm run test:scanner
npm run test:remote:browser
npm run pack:win
npm run dist:win
npm run build:icons
~~~

浏览器验收脚本需要本机 Chrome，可使用 `CHROME_PATH` 指定位置。测试会在 `.qa/` 下使用独立的目录和随机端口，不应指向真实录像目录。扫码图片测试依赖 `.toolchain/jdk` 和构建 Android 后缓存的 ZXing JAR，应先配置工具链并构建 Android。`.qa/` 可能含临时配对凭据、二维码和录像，不能公开。

## 架构约定

电脑端使用 Electron 启动本地工作台，并通过预加载脚本限制渲染进程的系统访问。视频和音频使用 WebRTC 传输；录制在电脑端合成并写入本地视频目录。局域网配对使用带证书指纹的短期凭据，跨网络配对使用远程信令服务和系统信任的 HTTPS。

修改连接、录制或媒体协商代码时，应同时运行对应的单元测试和浏览器验收。Android 真机、移动数据、实际公网 NAT 穿透和长时间运行需要单独在目标设备上验证。

## 发布前检查

1. 确认没有 `.flowcast/`、`.qa/`、`recordings/`、`.env`、签名文件或构建目录。
2. 使用 `node scripts/export-public.mjs` 生成源代码发布目录。
3. 检查导出清单只包含源代码、文档、示例配置和必要的图标资源。
4. 为 Windows 和 Android 构建时，分别遵守 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中的依赖许可要求。
