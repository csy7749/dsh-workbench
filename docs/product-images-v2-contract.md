# 产品图片 v2 格式契约

日期：2026-11-26（Asia/Shanghai）。本契约承接产品图片路线 IMG1-01，适用于新导入与后续加工产物。v1 生成／编辑候选继续按原格式读取，不原位迁移。

## 身份与目录

`requestId` 标识一次可重放的请求；`operationId` 标识一次领域操作；`candidateId` 标识候选描述与来源；`sha256` 标识实际文件字节。相同文件重复导入会得到不同操作和候选，但具有相同文件 hash。

v2 存储独立于 v1：

```text
.dsh-workbench/product-images-v2/<sha256(productId)[0:32]>/
  operations/<operationId>.json
  candidates/<candidateId>/manifest.json
  candidates/<candidateId>/original.<ext>
  selection.json
  metadata/<candidateId>.json
```

路径始终由宿主从已登记产品解析；请求只接受文件名、媒体类型与文件内容，不接受工作区路径或候选路径。所有目录与文件都必须是产品工作区内的真实目录／普通文件，不接受符号链接、硬链接或越界目标。

## 操作与候选

一次导入操作示例：

```json
{
  "schemaVersion": 2,
  "id": "<uuid>",
  "productId": "<registered-product-id>",
  "kind": "import",
  "status": "succeeded",
  "createdAt": "<ISO-8601>",
  "input": { "fileName": "forest-icon.png", "sha256": "<64-hex>", "mime": "image/png", "bytes": 1234 },
  "outputs": ["<32-hex-candidate-id>"]
}
```

候選 manifest 的 v2 必填欄位為 `schemaVersion: 2`、`id`、`productId`、`operationId`、`operationKind`、`createdAt`、`file`、`source`、`parents`。`file` 记录角色、受限文件名、MIME、字节数、宽高与完整 SHA-256。导入候选的 `source.kind` 为 `local-import`，保存净化后的原文件名、捕获时间与输入 hash；`parents` 为空。派生候选另保存父候选 ID 与父文件 hash，以及像素坐标空间中的变换 recipe。

候选 ID 从完整 manifest 描述（不含 `id`）的规范 JSON SHA-256 前 32 位派生。更改来源或操作会产生不同候选 ID；文件 hash 不作为来源身份。v2 每个候选目录仅包含 manifest 和受限的原图／成品文件。缩略图、标签、备注和检查报告不放入候选目录；当前 WebP 预览仅使用 Host 内存有界缓存，不写磁盘或候选目录。

未来由 v2 生成／编辑操作写入时，必须保留真实工具、渠道、模型与可得的 seed／远端 job 证据；缺失值记为未知。`import`、`process`、`render` 不能伪装为 `generate`，不能填假的 Provider 或模型。

## 采用、元数据与版本行为

`selection.json` 只保存 v2 候选 ID；v1 选择清单仍在原路径、保持原字节。候选引用在 API 中带 `formatVersion` 与 `candidateId`；为旧客户端省略版本的请求按 v1 解释。不能将 v2 ID 写入 v1 选择清单。

变动标签、备注与检查状态写入独立的 v2 metadata sidecar，其字段为 `formatVersion`、`productId`、`candidateId`、`fileSha256`、`tags`、`notes`、`checks`；最多 50 个标签，每个不超过 80 字符，备注不超过 4000 字符。检查结果以候选 hash 绑定并放在 `checks` 数组中。静态图片检查需分别报告 alpha 通道是否存在，以及是否有 alpha 小于不透明值的像素；检查通过不代表视觉或文字质量通过。

读取仅接受受支持的 schema 版本和字段组合。未知版本、损坏 manifest、hash／尺寸／解码不匹配、缺失操作引用、额外文件或越界链接均显式报错并隔离；不将错误状态显示成空图库。v1 仍由严格旧读取器校验，保持旧候选 ID、job、manifest、原图与 `selection.json` 字节不变。

v1 与 v2 的候选数量和原图／清单字节共用现有每产品配额。格式升级不重复执行旧请求；新增读取和导入均不调用模型。回退关闭 v2 写入口，v1 继续工作；v2 原始目录及受控导出保留，新选择不能承诺被 v1 页面显示。

## 当前覆盖范围

本阶段只开放 PNG、JPEG、WebP 的单帧静态导入，单文件上限 20 MiB、6400 万像素，并完整解码后计算 SHA-256。GIF、APNG、SVG、类型伪报、损坏或超限文件拒绝。预览缓存最多 64 项／32 MiB、单项最多 4 MiB，单边不超过 1024 像素；缓存不可持久化，重启后可重建。多文件工程、可编辑源、批次与生成参数仍未由本契约自动启用。
