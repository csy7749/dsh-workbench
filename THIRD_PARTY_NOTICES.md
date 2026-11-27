# 第三方组件与许可

`dsh-workbench` 本体遵循仓库既有许可。以下第三方组件作为 vendor 文件或运行时依赖，
用于「灵感」模块、原生游戏工作室及其本地图片处理工具。

| 组件 | 版本 | 许可 | 位置 | 用途 |
|---|---|---|---|---|
| [mind-elixir](https://github.com/SSShooter/mind-elixir-core) | 5.15.1 | MIT | `assets/vendor/mind-elixir/MindElixir.iife.js`、`MindElixir.css` | 思维导图编辑（内联编辑 / 拖拽 / 撤销 / 折叠 / 快捷键） |
| [Apache ECharts](https://echarts.apache.org/) | 6.1.0 | Apache-2.0 | `assets/vendor/echarts.min.js` | 力导图（`graph` + `layout:force`，拖拽 / 缩放 / 邻接高亮） |
| [Three.js](https://threejs.org/) | r181 | MIT | `assets/vendor/threejs-game/three-gltf-runtime.js`、`LICENSE` | 原生 3D 游戏模板，包含 GLTFLoader 和 OrbitControls |
| [Cinderwatch](https://github.com/kevintngo/cinderwatch) | `6640b81286df8b1fd2e5a745b48211c4a9323f83` | MIT | `assets/vendor/cinderwatch/src/`、`LICENSE`、`PROVENANCE.json` | 完整程序化 Three.js 塔防模板；适配修改在 `src/host/native-game-cinderwatch.mjs` |
| Cinderwatch 使用的 [Three.js](https://threejs.org/) | r170 | MIT | `assets/vendor/cinderwatch/vendor/three.module.min.js`、`LICENSE-three.txt` | 保留塔防自定义 shader 对应的版本，离线内嵌，与 r181 模型加载运行时独立 |
| [OhMyGame](https://github.com/WhiteTowerAI/ohmygame) 媒体处理适配 | 0.0.0-beta.5.8 | Apache-2.0 | `src/host/native-game-media.mjs` | 本地图片裁切与精灵表网格切分；工作台重写了项目路径、输出与权限适配，未搬入 OhMyGame 应用或画布 |
| [sharp](https://github.com/lovell/sharp) | 0.35.5 | Apache-2.0 | 运行时依赖 `node_modules/sharp` | 本地图片解码与裁切、格式编码 |
| [sharp Windows x64 prebuilt](https://github.com/lovell/sharp) | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | 运行时依赖 `node_modules/@img/sharp-win32-x64`；包含 libvips 8.18.7 | sharp 的 Windows x64 原生图像处理实现 |

## 说明

- vendor 文件保留了各自构建产物中的版权声明；Three.js 的完整 MIT 条款另存于 `assets/vendor/threejs-game/LICENSE`。
- mind-elixir 通过 `<script>` 注入 `document.head`（IIFE 全局 `MindElixir`），样式表注入 Shadow Root；
  ECharts 同样以 `<script>` 注入后使用全局 `echarts`。
- 两者的加载路径由宿主白名单路由提供（`/workbench-api/assets/vendor/*`），只放行上述三个文件名。
- Three.js 由原生游戏宿主读取并嵌入生成的单文件 HTML，支持离线运行。
- OhMyGame 的 Apache-2.0 许可文本保留在 `third_party/ohmygame/LICENSE`；本适配只复用了媒体处理思路和受限图片操作，不包含其项目管理、画布或 Electron 运行时。
- sharp 及平台原生依赖由 npm 按运行平台安装；原生包各自附带其许可文件。锁文件记录可复现的版本和完整性摘要。
- 若需要离线或内网分发，直接保留 `assets/vendor/` 目录即可，无需额外构建步骤。
