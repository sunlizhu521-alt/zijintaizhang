# 资金台账

基于四类 Excel 来源，集中查看付款计划、台账累计已付与剩余、三类预估及待核对问题。原始文件、解析结果、历史版本、用户和系统记录统一保存在服务器 SQLite 数据库中。

代码仓库：<https://github.com/sunlizhu521-alt/zijintaizhang>。部署状态以 GitHub Actions、健康接口和页面验收结果为准。

## 架构

- 前端：React 19 + Vite，页面和静态资源前缀为 `/zijintaizhang/`。
- 后端：Express 5，API 前缀为 `/zijintaizhang/api`。
- 存储：Node 内置 `node:sqlite`，启用 WAL、外键及事务；原始 Excel 以 BLOB 保存在数据库。
- Excel：ExcelJS 读取工作簿，yauzl 检查压缩结构；解析在限时、限内存的独立 Worker 中执行，同一进程一次处理一个文件。
- 生产：Nginx HTTPS → `127.0.0.1:4010` → PM2 单实例；每个发布包携带自己的 Linux x64 Node 22，不替换服务器全局 Node。

主要代码：`src/` 为页面，`server/parser.js` 为解析口径，`server/dashboard.js` 为汇总规则，`server/storage.js` 为文件版本，`server/auth.js` 为认证权限，`shared/constants.js` 为槽位、类别和权限定义。

## 本地运行与验证

建议使用最新 Node 22，至少为 22.16.0，以支持部署备份脚本使用的 `node:sqlite.backup`。首次运行：

```bash
npm ci --ignore-scripts
npm test
npm run build
npm run admin:init
npm start
```

访问 <http://127.0.0.1:4010/zijintaizhang/>。`admin:init` 必须在交互式 Terminal 中运行，隐藏输入两次密码；没有默认账号密码，已有管理员时不会重复初始化。

开发时分别在两个 Terminal 中运行：

```bash
npm run dev
```

```bash
npm run client
```

前端开发地址为 <http://127.0.0.1:5173/zijintaizhang/>，Vite 将 API 转发至本机 4010。测试使用合成数据和临时数据库；接口测试需要允许监听本机临时端口。

本地默认数据库为 `data/zijintaizhang.sqlite`。可用 `DATA_DIR` 指定数据目录；服务支持 `HOST`、`PORT`。生产模式还要求 HTTPS `PUBLIC_ORIGIN`，本项目反向代理使用 `TRUST_PROXY=loopback`。生产配置由 PM2 文件读取，不在代码中保存管理员密码。

## 四个文件槽位与统计口径

每个槽位只有一个当前有效版本。上传先预览，再确认启用；数据校验失败、解析超时或并发版本冲突时保留原有效版本。待上传草稿一小时后失效。同一用户重新选择同一槽位的文件会替换该槽位尚未启用的草稿。

| 槽位 | 读取范围 | 付款月份与金额来源 |
| --- | --- | --- |
| 付款节奏 | 固定读取 `谈判付款` 和 `正常付款` 两张表，均须存在 | 谈判付款取 `YYYY年M月支付` 列；正常付款取 `应付时间` 与 `本次申请付款金额` |
| 发货计划预估 | 选择符合预估模板的工作表 | `预估付款月份`、`申请付款金额` |
| 售后配件预估 | 同上 | 同上 |
| 已发货未登记台账预估 | 同上 | 同上 |

付款节奏必需字段：

- 两张表均需供应商、付款主体、摘要、已付金额、剩余付款金额（或剩余金额）。供应商表头支持 `供应商` 或 `供应商名称`。
- 谈判付款另需 `OA-申请付款金额`、`应付款时间`，以及至少一列带年份的月支付表头。
- 正常付款另需 `本次申请付款金额`、`应付时间`。

三个预估槽位的模板必需表头为：`预估付款月份`、`供应商名称`、`付款主体`、`摘要`、`申请付款金额`、`账期`、`备注`。系统在前十行识别表头；预估工作表默认选择格式有效的可见表，名称含“原始、备份、汇总、合计”的表默认不计入，可在预览中人工选择符合格式的表。

统计规则：

- 付款计划分为谈判付款和正常付款；三类预估分别列示。当前有效版本参与汇总，历史版本不重复计入。
- 付款计划和预估按月份筛选；台账累计已付、剩余只受供应商、付款主体、跟单员、类别筛选，不受月份筛选影响。
- 日期缺失、缺少年份或格式不明确时单列“时间待定”，不计入明确月份的金额卡片。谈判付款所有月支付单元格均为空时，将原申请金额列入时间待定；有月计划时保留这些计划，不自动分摊差额。
- 已付、剩余来自源表。空值保留为未知并提示，明确的零值保留为零；不根据“归档”或“已结清”等状态推算已付金额。
- 金额按“分”存储和求和，超过两位小数按四舍五入处理。负金额保留并提示复核；超出安全计算范围时拒绝导入或汇总。
- 月计划合计与申请金额不一致、已付加剩余不一致、状态矛盾、缺失付款主体等进入待核对问题，不自动改写原值。
- 相同流程号，以及供应商、付款主体、计划金额相同且月份相同或相邻的记录，会提示可能重复；不自动去重或扣减金额。
- 明细保留来源文件、工作表、行号、原始字段、备注和单元格批注，便于回查。下载原始文件返回上传时的原文件。

仅接受不超过 20 MiB 的 `.xlsx`；不支持加密文件、宏或外部工作簿链接。解压内容上限 200 MiB、压缩条目上限 5,000、有效记录上限 100,000。每次解析限时 30 秒；文件即使小于上传大小限制，也可能因解压体积、解析内存或耗时超限而被拒绝。

服务器不会重新计算 Excel 公式。公式单元格须有已保存的计算结果；上传前应在 Excel 或 WPS 中完成计算并保存。

## 用户、权限与记录

管理员在系统内创建用户、分配权限、停用账号和重置密码。用户首次使用新建或重置的密码登录时必须先修改密码；密码须为 15 至 128 个字符。最后一位启用中的管理员不能被停用或降级。

权限由服务器接口强制校验：

| 权限 | 对应能力 |
| --- | --- |
| `dashboard` | 查看资金看板 |
| `files` | 查看文件管理、版本和解析明细 |
| `upload` | 上传预览并替换文件，同时需要 `files` |
| `download` | 下载原始文件，同时需要 `files` |
| `restore` | 恢复历史版本，同时需要 `files` |
| `export` | 导出查询结果，同时需要看板或对应记录的查看权限 |
| `logsLogin`、`logsOperation`、`logsSecurity` | 分别查看登录、操作、安全异常记录 |

管理员拥有全部权限及用户管理能力。停用、重置密码或修改权限会撤销该用户现有会话；自行修改密码会撤销旧会话并建立新会话。

密码使用 scrypt 哈希；会话最长 24 小时，数据库只保存会话 token 的哈希。生产 Cookie 使用 HttpOnly、Secure、SameSite=Strict；写入接口验证 CSRF 和请求来源。Nginx 覆盖客户端传入的转发 IP 头，后端只信任回环代理。

登录记录区分成功登录与失败尝试：失败记录中的账号仅是提交的账号，不能视为已确认身份。操作记录包括文件启用/恢复/下载/导出及用户权限变更。安全异常包括连续登录失败、请求频率超限、越权、CSRF/来源错误和疑似路径探测。

当前限制为每 IP 每分钟 120 次 API 请求；账号或 IP 在 15 分钟内累计五次登录失败后短时限制 15 分钟。成功登录不清零同 IP 的失败计数。限流计数为单进程内存状态，重启会清零。安全异常是排查线索，不等于已确认攻击或识别了攻击者。

系统记录使用 UTC 存储，页面按北京时间显示；启动时及每日任务清理超过 365 天的记录。日志不保存密码、会话 token 或完整请求正文。

## 腾讯云与 GitHub Actions 部署

当前代码中的部署目标配置如下，不代表已经完成线上验收：

```text
入口：https://129.211.9.242/zijintaizhang/
健康接口：https://129.211.9.242/zijintaizhang/api/health
服务器目录：/home/ubuntu/zhuge-ai-lab/zijintaizhang
PM2 名称：zijintaizhang
监听：127.0.0.1:4010
```

目录约定：

```text
zijintaizhang/
├── bin/receive-deploy.sh       # 首次安装的受限 SSH 接收入口
├── bin/deploy-release.sh       # 首次安装的发布与回切脚本
├── releases/<提交SHA>/         # 代码、依赖、dist、独立 runtime/node
├── current -> releases/<SHA>
├── incoming/                  # 临时发布文件
└── shared/
    ├── config.json
    ├── data/zijintaizhang.sqlite
    ├── backups/
    └── logs/
```

`shared/config.json` 由首次部署配置，内容须与已审查的固定目标一致：

```json
{
  "port": 4010,
  "publicOrigin": "https://129.211.9.242",
  "host": "127.0.0.1",
  "trustProxy": "loopback"
}
```

GitHub 仓库设置：

| 类型 | 名称 | 用途 |
| --- | --- | --- |
| Actions variable | `DEPLOY_HOST` | `129.211.9.242` |
| Actions variable | `DEPLOY_USER` | `ubuntu` |
| Actions secret | `DEPLOY_SSH_KEY` | 本项目专用 SSH 私钥 |
| Actions secret | `DEPLOY_KNOWN_HOSTS` | 经可信服务器控制台核验的主机公钥记录 |

首次配置需要：Linux x86_64、Python 3、PM2、curl、ss、flock、timeout；上述项目目录应由部署用户拥有。下载校验使用 Python 标准库，内嵌在 `receive-deploy.sh` 中，无额外 helper 或 Python 依赖。先将固定提交中的两份部署脚本校验 SHA256 后安装到 `bin/`，再配置专用公钥的强制命令：

```text
restrict,command="/home/ubuntu/zhuge-ai-lab/zijintaizhang/bin/receive-deploy.sh" <本项目SSH公钥>
```

接收入口只接受 `deploy <40位提交SHA>`，stdin 是不超过 16 KiB 的下载清单，不接受交互式 shell、SFTP 或直接传入 tar。此入口限制部署命令；应用仍以 ubuntu 身份运行，不构成独立系统用户隔离。服务器 `bin/` 下的两份脚本不会被普通发布包覆盖，更新它们需另行审查安装。

Nginx 按 `deploy/nginx-location.conf.example` 只在现有 HTTPS server 中增加本项目路径，保留原证书、根路由和其他项目配置；验证配置成功后再 reload。HTTPS 证书续期属于既有入口运维范围。

`.github/workflows/deploy.yml` 的流程：

1. PR 运行测试与构建；`main` 推送或在 `main` 手动运行时继续部署。同一分支的任务串行，不取消正在执行的部署。
2. 在 Ubuntu 24.04 + 最新 Node 22 上安装锁定依赖、测试、构建，再仅安装生产依赖并打包独立 Node 二进制及校验信息。
3. 将发布包上传到 Actions Artifact，保留一天。Runner 用本次任务的短期 `GITHUB_TOKEN`（`actions: read`）取得临时 HTTPS 地址，通过固定 known_hosts 校验的 SSH 只发送小型下载清单。服务器不保存或接收 GitHub token。
4. 接收端只接受 GitHub Actions 使用的 `productionresultssa<数字>.blob.core.windows.net` HTTPS 存储地址；拒绝其他域名、非443端口、私网 DNS 结果和重定向，连接固定到已验证的公网 IP。为适应跨境链路，使用最多8个并行分段，总限时20分钟、单次连接限时10秒；严格核对每段 Content-Range，再核验完整 ZIP 和 tar 的 SHA256、预期大小及 ZIP 内唯一文件，执行原 tar 的路径白名单、体积、重复路径和 runtime 校验。临时下载URL不写日志；失败最多重试三次，每次重新获取签名地址。
5. 校验 4010 未占用，或确认其属于本项目的既有 PM2 进程；检查现有数据库备份和完整性后，切换 `current`，只重启 `zijintaizhang`。
6. 检查本机及 HTTPS 健康接口返回的应用名和提交 SHA；发布窗口内失败时尝试恢复前一版本。Actions 再从外部检查 HTTPS 健康接口和首页。

服务器不执行 npm 安装或前端构建，也不升级全局 Node。旧代码版本保留在 `releases/`；同一提交的发布目录保持不变，失败版本需审查后处理或通过新提交发布。

生产管理员首次初始化必须使用本项目的 Node 和共享数据目录，在交互式 Terminal 中执行：

```bash
DATA_DIR=/home/ubuntu/zhuge-ai-lab/zijintaizhang/shared/data \
  /home/ubuntu/zhuge-ai-lab/zijintaizhang/current/runtime/node \
  /home/ubuntu/zhuge-ai-lab/zijintaizhang/current/scripts/admin-init.js
```

不要将管理员密码放在命令行参数、GitHub 仓库或工作流日志中。

## 备份、版本恢复与边界

- **文件历史版本恢复**：在页面选择某一槽位的历史版本，改变该槽位的当前有效版本；其他槽位、原始版本和用户不变。并发更新会被版本号校验阻止。
- **发布前备份**：已有数据库时，部署脚本使用 SQLite 在线备份，将 WAL 中已提交内容一并保存到 `shared/backups/predeploy-*.sqlite`，并执行 `PRAGMA quick_check`。备份包含用户、文件原件、所有文件版本及系统记录。
- **代码发布回切**：恢复前一个 `current` 和本项目 PM2 进程，不自动恢复数据库，不抹去发布期间产生的数据。后续数据库结构变更须考虑旧版本兼容性。
- **完整数据库恢复**：属于运维操作。先确认回退时间范围，只停止本项目；保留当前数据库及 WAL/SHM，再验证并恢复选定备份，隔离旧 WAL/SHM 后启动并验收。恢复会回退备份之后的账号、上传版本及系统记录，不能与普通代码回切混同。

当前提供发布前的本机备份；定时、异地备份和备份保留期需另行配置。文件历史版本和发布备份不会自动清理，需监控磁盘空间。审计记录清理期限为 365 天，与文件版本和备份保留无关。

`.gitignore` 排除运行数据、SQLite、Excel/CSV、日志、环境文件、依赖和构建产物。业务原文件与数据库不应提交到代码仓库。
