# Hand Note Layers

Hand Note Layers 是一个 Obsidian 插件，用于在 Markdown 和 PDF 文件上添加基于笔记层的手写标注。

## 功能

- 在 Obsidian 原生文件中直接创建手写标注，不修改源文件。
- 支持 Markdown 文件。
- 支持 PDF 文件，包含翻页和缩放。
- 使用手指或 Apple Pencil 书写。
- 手形浏览、钢笔、铅笔、荧光笔、整笔橡皮擦。
- 预设色板、自定义颜色、独立工具粗细和压感笔宽。
- 撤销、重做、清除当前层。
- 默认手指滚动、Apple Pencil 书写，可切换为手指书写。
- 支持标准触控笔侧键/橡皮事件切换绘图工具与橡皮擦。
- 多个笔记层，层与层之间互不影响。
- 图层显示、隐藏、重命名、排序和透明度调整。
- 自动保存到 vault 中的 `.hand-note-layers` 目录。
- 工具栏显示保存状态，并支持立即保存。
- 支持桌面端和 iPad 移动端。

## 在 iPad 上安装

1. 在 Obsidian 设置中关闭安全模式或受限模式。
2. 安装社区插件 BRAT。
3. 启用 BRAT。
4. 执行命令 `BRAT: Add a beta plugin for testing`。
5. 输入本插件的 GitHub 仓库地址。
6. 安装完成后启用 Hand Note Layers。

## 使用

打开一个 Markdown 或 PDF 文件，然后：

- 点击左侧 Ribbon 中的 `pen-tool` 图标。
- 或执行命令 `用 Hand Note Layers 标注当前文件`。

Markdown 文件会进入独立的标注视图。PDF 文件默认会使用 Hand Note Layers 的 PDF 标注视图打开。

Apple Pencil 2 的笔背双击属于 iOS 原生 `UIPencilInteraction`。Obsidian
社区插件目前无法直接读取该原生回调；插件已支持 Web Pointer Events
能够提供的触控笔侧键/橡皮事件，并提供 `切换绘图工具与橡皮擦` 命令。

## 数据存储

每个源文件对应一个标注 JSON 文件，保存位置：

```text
.hand-note-layers/源文件路径.json
```

标注文件不会修改原始 Markdown 或 PDF 内容。

## 本地开发

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
```

构建后确认仓库根目录包含：

```text
main.js
manifest.json
styles.css
```

## GitHub Release

创建并推送 Git tag 后，GitHub Actions 会自动构建并发布 Release。

```bash
git tag v0.1.0
git push origin v0.1.0
```
