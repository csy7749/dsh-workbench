# 通用 Demo 库

工作台内部「研发 → DEMO」视图统一展示两类内容：当前项目的网页原型，以及由工作台随包发布的内置 Demo Pack。内置 Demo 不要求先选择项目；网页原型继续保留项目归属、版本、归档和 HTML 预览。

## 内置 Demo Pack

`src/packs/demo-library.mjs` 是注册目录；每个 Demo Pack 的元数据单独放在领域 pack 内，例如 `src/packs/game/cinderwatch-demo.mjs`。目录项可以声明类型、标题、介绍、标签、缩略图和预览地址、工作流模板 ID、节点清单、代码路径分组、验收说明、验证命令、许可与来源。

增加一个内置 Demo 时，新增 manifest 并把它注册到 `BUILTIN_DEMO_LIBRARY`。需要提供受控预览和缩略图入口。运行时代码归各自业务目录所有；manifest 负责把相关文件列在一起，不复制工作流 runner、游戏工坊、HTTP 管线等共享实现。

Cinderwatch 的 manifest 把工作流模板 `game-cinderwatch-test`、相关节点、19 个上游 JavaScript 模块、Three.js r170、宿主适配、真实浏览器试玩、验证脚本和许可说明放在同一条 Demo 目录记录里。它仍通过共享游戏服务执行创建、构建、试玩和离线导出。

## 试玩 Cinderwatch

1. 在工作台打开「研发 → DEMO」，选择「Cinderwatch · 烬火守望」卡片；无需先选择项目。
2. 在「运行预览」中直接试玩，或点击「新窗口试玩」。支持 PC、平板和移动视口；点击游戏后可用数字键 1–4 选塔、U 升级、C 切换指挥、P 暂停、空格提前叫波。
   - 内嵌预览和独立试玩页均有「关闭试玩」按钮，关闭即卸载游戏；内嵌预览可点击「重新试玩」再开始。离开 DEMO 视图也会停止内嵌游戏。
   - 从 Demo 库打开的独立试玩可直接关闭窗口。普通标签页若不允许脚本关闭，会显示「试玩已关闭，可关闭此标签页」，此时游戏已停止，也可点击「重新试玩」。
3. 「节点与代码」列出工作流节点和源码位置；点击「打开工作流模板库」后选择 `game-cinderwatch-test`，可继续创建、构建、试玩和离线导出流程。
4. 「验收与来源」可查看验证命令、人工验收范围和 MIT 许可来源。内置试玩不会创建项目工程或启动模型任务。

## 项目网页 Demo

网页 Demo 从原有 `demos` 表读取。用户可以为某个网页 Demo 上传 PNG、WebP 或 JPEG 封面；宿主将其裁切到 640×400、转换为 WebP，并放在项目工作区 `.dsh-workbench/demos/<demoId>/thumbnail.webp`。缩略图按 Demo ID 读取，不接受客户端文件路径。图片最大输入为 12 MB / 1600 万像素，转换前还会限制内容大小。

内置缩略图不走文件路径参数：图库路由仅服务 manifest 登记的资源。内置游戏预览由固定模板和默认规则生成，页面启用内容安全策略并禁止联网请求。

## 验证

```powershell
npm run verify:demo-library
npm run verify:demo-library:browser
```

第一项检查覆盖内置目录、Cinderwatch 离线预览与缩略图、项目网页 Demo 列表和缩略图上传/读取。第二项使用本机已安装的 Playwright 与浏览器，验证实际 Demo 组件的卡片、封面显示、沙箱内游戏渲染、内嵌与独立试玩的关闭/重开及详情切换；不下载浏览器，也不代表真人试玩验收。运行前需完成 `npm run bundle:host`。
