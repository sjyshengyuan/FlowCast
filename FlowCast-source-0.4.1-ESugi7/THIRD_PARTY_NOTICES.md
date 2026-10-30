# 第三方组件说明

MIT 许可证只适用于 FlowCast 自有代码、文档和图标素材。依赖、运行时和发布包中的第三方组件继续适用各自的许可证。

## 运行时组件

- **FFmpeg**：项目通过 `ffmpeg-static` 使用静态 FFmpeg 二进制。当前 npm 包 5.3.0 声明 GPL-3.0-or-later，Windows 二进制为 Gyan 的 FFmpeg 6.1.1 essentials 构建，随依赖附带 GPL v3 许可证和构建说明，源码版本见 [FFmpeg e38092ef93](https://github.com/FFmpeg/FFmpeg/commit/e38092ef93)。分发包含 FFmpeg 的安装包时，请保留对应的许可证、版权和源代码获取信息；不要把整个安装包标为仅 MIT。
- **qrcode 1.5.4 / selfsigned 5.5.0 / ws 8.22.0**：各包的元数据声明为 MIT；具体版权声明见安装后的对应 LICENSE 文件。
- **Electron**：桌面运行时由 Electron 提供，遵守 Electron 及其内置 Chromium、Node.js 组件的许可证。
- **Android WebRTC**：Android 构建使用 WebRTC/相关 Android 依赖，许可证以 Gradle 解析到的版本及其随包 NOTICE 为准。

完整依赖版本来自 `package-lock.json` 和 Android Gradle 配置。发布二进制前请检查依赖包中的 LICENSE/NOTICE 文件，并把它们一并放入发布附件或安装包的说明目录。

参考：

- [FFmpeg GPL](https://ffmpeg.org/legal.html)
- [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)
- [Electron licenses](https://www.electronjs.org/docs/latest/tutorial/licenses)
- [WebRTC license](https://webrtc.googlesource.com/src/+/main/LICENSE)

