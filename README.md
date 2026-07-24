# FFmpeg Studio

一个带图形界面的本地视频处理工作台，把命令行工具 `ffmpeg` / `ffprobe` 包装成好用的 Web UI 与桌面程序。支持**转码、拼接、滤镜、媒体信息查看、音频提取**，所有处理都在你本机完成，文件不会上传到任何服务器。

![FFmpeg Studio](docs/preview.png)

## ✨ 功能

| 模块 | 说明 |
| --- | --- |
| **转码** | 格式（MP4 / MKV / MOV / WebM / AVI / GIF）、视频编码（H.264 / H.265 / VP9 / AV1）、CRF / 预设、分辨率、帧率、音频编码与码率、faststart |
| **拼接** | 勾选多个文件并调整顺序；支持「重编码」（兼容不同格式）与「流复制」（同格式更快） |
| **滤镜** | 缩放、旋转（90/180/270）、水平/垂直翻转、裁剪、降噪、亮度/对比度、倍速、淡入淡出、文字水印、静音 |
| **媒体信息** | 基于 ffprobe 解析时长、分辨率、码率、编码等，可展开完整 JSON |
| **音频提取** | 从视频中抽出音轨（AAC / MP3 等） |
| 通用 | 拖拽上传、实时 ffmpeg 命令预览、进度条 + 实时日志流、一键下载 |

## 🧰 技术栈

- 后端：Node.js 内置 `http` 模块（零第三方依赖），调用系统 `ffmpeg` / `ffprobe`，通过 SSE 推送进度与日志
- 前端：原生 HTML / CSS / JavaScript（无框架）
- 桌面端：Electron + electron-builder，将 Web 版打包成 Windows 原生程序

## ⚙️ 环境要求

- 已安装 **ffmpeg** 与 **ffprobe**，且在 `PATH` 中（桌面版依赖系统 ffmpeg）
  - 验证：`ffmpeg -version`
- Node.js 18+（仅 Web 版或二次打包时需要）

## 🚀 快速开始（Web 版）

```bash
git clone https://github.com/lly5848/ffmpeg-studio.git
cd ffmpeg-studio
# 直接用已安装的 Node 启动（无需 npm install，后端零依赖）
node server.js
# 自定义端口： PORT=8080 node server.js
```

打开浏览器访问 **http://localhost:5180** 即可使用。

## 🖥️ 桌面程序

已打包好的 Windows 安装包 / 便携版在 GitHub Releases 下载（或由你自己打包）：

```bash
npm install                 # 安装 Electron 等构建依赖
npm run dist               # 生成 dist/ 下的安装版与便携版 exe（带自定义图标）
```

> 打包说明：Electron 官方源在国内可能被重置，可设置镜像后安装：
> ```bash
> export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
> npm install --registry=https://registry.npmmirror.com
> ```

桌面版运行时数据（上传 / 输出文件）默认存放在：
`%AppData%/Local/Programs/ffmpeg-studio/data`

## 📁 项目结构

```
ffmpeg-studio/
├── server.js            # 后端：上传/信息/任务执行/SSE 进度（零依赖）
├── main.js              # Electron 入口：启动服务并打开原生窗口
├── package.json         # 依赖与打包配置
├── build/
│   └── icon.ico         # 应用图标（多尺寸）
├── public/              # 前端 UI
│   ├── index.html
│   ├── style.css
│   └── app.js
├── uploads/             # 上传文件（运行期生成，已被 .gitignore 忽略）
├── outputs/             # 处理输出（运行期生成，已被 .gitignore 忽略）
└── dist/               # 打包产物（已被 .gitignore 忽略）
```

## 📝 使用提示

- **文件名含空格或 `&`、`(`、`)`**：程序已自动用引号包裹路径，无需手动处理。
- **水印文字**：本机若缺少 fontconfig，程序会在启动时自动探测 `C:\Windows\Fonts\arial.ttf` 并通过 `fontfile=` 显式指定，水印可正常工作。
- **端口冲突**：若 5180 被占用，用 `PORT=xxxx node server.js` 换端口；桌面版同理。

## 🔧 HTTP 接口（供二次开发）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/upload?name=` | 接收二进制上传 |
| GET  | `/api/files` | 列出媒体库文件 |
| POST | `/api/info` | ffprobe 媒体信息 |
| POST | `/api/transcode` | 转码任务 |
| POST | `/api/concat` | 拼接任务 |
| POST | `/api/filter` | 滤镜任务 |
| POST | `/api/extract-audio` | 音频提取任务 |
| GET  | `/api/progress/:jobId` | SSE 进度 / 日志流 |
| GET  | `/api/download?file=` | 下载输出文件 |

## 📄 许可证

MIT
