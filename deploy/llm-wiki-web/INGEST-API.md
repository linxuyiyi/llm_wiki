# LLM Wiki Web：单文件摄取与定时导入

适用版本：0.6.11 Web Edition，统一入口 8080。此次更新网关与 Web 页面，Rust 后端沿用已验证的 ARM64 / glibc 2.28 兼容版本（源码基线 60084f4）。运行环境：Linux ARM64，Node.js >=20，glibc >=2.28。

## 已有文件提取 Wiki

```bash
curl -X POST "$LLM_WIKI_URL/api/v1/projects/$PROJECT_ID/sources/ingest" \
  -H "Authorization: Bearer $LLM_WIKI_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"path":"raw/sources/astra/example.md"}'
```

`path` 是项目内的资料相对路径，也接受省略 `raw/sources/` 的写法。资料必须已存在，不重复上传，不批量摄取。

返回 HTTP 202，包含 `job.id` 和 `statusUrl`。通过以下请求查询：

```bash
curl "$LLM_WIKI_URL/api/v1/ingest-jobs/$JOB_ID" \
  -H "Authorization: Bearer $LLM_WIKI_API_TOKEN"
```

任务状态：`pending`、`running`、`succeeded`、`failed`。成功结果包含已确认存在的 Wiki 文件列表 `job.filesWritten`；失败结果包含 `job.error`。HTTP 202 仅表示任务接收。任务在服务端持续执行，无需保持浏览器或请求连接。

鉴权复用设置页面保存的 API Token，也支持 `LLM_WIKI_API_TOKEN` 环境变量（优先）。公开摄取接口始终需要 Token。同一项目、文件和内容的在途请求合并为同一任务；内容修改会创建后续任务。重启时恢复未完成任务，原生摄取缓存避免重复模型调用。

## 上传后自动提取

在现有上传 API 后加 `?ingest=true`：

```bash
curl -X PUT "$LLM_WIKI_URL/api/v1/projects/$PROJECT_ID/sources/file?ingest=true" \
  -H "Authorization: Bearer $LLM_WIKI_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"path":"astra/example.md","content":"# 参数升级经验\n规则变更需覆盖边界值。"}'
```

文本使用 `content`，PDF、DOCX 等二进制使用 `contentBase64`，二者只能传一个。上传并创建摄取任务后返回 HTTP 202；结果查询同上。不加 `ingest=true` 时保留原有上传行为。单文件最大 100 MiB。

## 定时导入和立即扫描

Web 版改由网关每 10 秒检查一次已保存的配置，按各项目的分钟间隔启动导入。浏览器关闭、项目未打开也可执行。

1. 在设置里启用定时导入，填写服务器上的外部目录，例如 `/autotest/inbox`，设置间隔并保存。
2. 目录必须在 `LLM_WIKI_DATA_DIR` 内，且位于当前项目之外；项目的 `raw`、`wiki`、`.llm-wiki` 目录由原始资料监控管理。
3. 点击「立即扫描」后，页面等待服务端任务并显示成功或具体错误。未保存的目录可以用于本次扫描，但不会改变已保存目录的定时配置。
4. 新增或变更文件复制到 `raw/sources/scheduled-import/`，复用原有解析、摄取、缓存、索引更新及删除同步逻辑。只有摄取成功才记录导入哈希和成功扫描时间；失败可重试。

仍使用已有资料过滤、文件大小限制、MinerU、输出语言、模型预设和项目模型设置。模型配置需在设置中保存。空目录或全被过滤的目录可能扫描成功但没有新增 Wiki。

故障详情可查询任务接口或查看启动日志中 `[web-ingest]` 信息。修改后的网页需要刷新，以加载新版本资源。

## 升级

停止旧服务，备份原程序，解压发布包。用新包的 `bin/`、`gateway/`、`web/`、`start.sh` 更新原安装目录；保留原数据目录、HTTPS/Nginx 配置和环境变量，沿用现有服务方式重新启动。

例如原部署的数据根为 `/autotest`，启动仍使用：

```bash
LLM_WIKI_DATA_DIR=/autotest ./start.sh
```

包内已包含运行依赖，无需在服务器上安装 npm 包或重新编译。此次交付为 Linux ARM64 服务端包。

## 验证范围

- Web 页面类型检查与生产构建。
- 87 条扫描、解析、摄取队列回归；27 条 MCP/API 回归；资料生命周期回归。
- 实际 ARM64 Rust 后端经 QEMU 运行，真实 HTTP 网关、磁盘解析和 Wiki 写入；模型使用本地确定性模拟服务。
- 验证单文件、上传后摄取、重复请求合并、缓存命中、立即扫描、无页面定时扫描、模型失败与重试、重启恢复。
- 包内 ELF 的最高 GLIBC 符号要求为 2.28。
- 未连接公司 GLM-5.2 或访问公司生产资料；实际模型质量与生产连接需在部署后验证。
