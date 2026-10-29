[**English**](README.md) | [**中文**](README.zh-CN.md)

# Current — 兼容 Fever 协议的 RSS 阅读器后端

![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black) ![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white) ![D1](https://img.shields.io/badge/D1-FFA116?style=for-the-badge&logo=cloudflare&logoColor=white)

**Current** 是一个自托管的 RSS 阅读器后端，实现了 [Fever API](https://feedafever.com/api) 协议。使用**纯 JavaScript**（ES modules，无运行时依赖）编写，运行在 **Cloudflare Workers** 上，以 D1 作为数据库、KV 作为缓存层。

可作为任何兼容 Fever 的 RSS 客户端（如 [Reeder](https://reederapp.com)、[fluent-reader](https://hyliu.me/fluent-reader) 等）的服务端同步引擎。

---

## 目录

- [功能特性](#功能特性)
- [架构](#架构)
  - [存储层](#存储层)
- [前置要求](#前置要求)
- [部署](#部署)
- [配置](#配置)
- [使用 —— 连接 RSS 客户端](#使用--连接-rss-客户端)
  - [通用设置](#通用设置)
  - [添加订阅源](#添加订阅源)
  - [标记为已读](#标记为已读)
- [API 参考](#api-参考)
- [技术栈](#技术栈)
- [路线图](#路线图)
- [许可证](#许可证)

---

## 功能特性

- **Fever API v3** — 完整的读/同步协议实现：分组、订阅源、条目、已读/未读/收藏状态
- **订阅源格式支持** — 内置零依赖解析器，支持 **RSS 2.0**、**Atom** 和 **JSON Feed**
- **并发抓取** — 并行抓取多个订阅源，支持可配置并发数
- **定时自动同步** — 通过 Workers Cron Triggers 定时刷新订阅源（默认每小时）
- **启动时抓取** — 部署后首次 HTTP 请求触发一次全量同步
- **KV 缓存** — D1 查询结果缓存在 KV 中以加速 API 响应；数据变更时选择性失效缓存
- **去重** — 数据库层唯一索引防止 `(feed_id, url)` 和 `(feed_id, title)` 重复条目
- **CORS 支持** — 为基于 Web 的 RSS 客户端启用跨域请求
- **可观测性** — 结构化 `[INFO]` / `[WARN]` / `[ERROR]` 日志，可在 Cloudflare Dashboard 中查看
- **安全认证** — 使用常量时间字符串比较进行 API key 验证

## 架构

```
┌──────────────────────────┐
│  兼容 Fever 的客户端      │  (Reeder, Fiery Feeds 等)
│  GET/POST ?api&...       │
└─────────┬────────────────┘
          │ Fever API 协议
          ▼
┌──────────────────────────┐
│   Cloudflare Worker      │  纯 JavaScript（ES modules）
│   ┌──────────────────┐   │
│   │  fever.js        │   │  API 请求路由与响应
│   │  auth.js         │   │  md5(email:password) 认证
│   │  fetcher.js      │   │  并发 RSS 抓取与解析
│   │  feedparser.js   │   │  RSS / Atom / JSON Feed 解析
│   │  db.js           │   │  D1 数据库访问层
│   │  cache.js        │   │  KV 缓存旁路层
│   │  var.js          │   │  环境变量运行时配置
│   │  models.js       │   │  数据模型与 Fever API 响应类型
│   └──────────────────┘   │
└──────────────────────────┘
          │
     ┌────┴────┐
     ▼         ▼
┌─────────┐ ┌──────┐
│  D1 DB  │ │  KV  │
│  SQLite │ │缓存  │
└─────────┘ └──────┘
```

### 存储层

| 层       | 技术                | 用途                                         |
|----------|---------------------|----------------------------------------------|
| **数据库** | Cloudflare D1 (SQLite) | 订阅源、分组、条目、阅读状态                  |
| **缓存**   | Cloudflare KV          | D1 查询缓存，加速读取（订阅源、分组、未读/收藏 ID、条目计数） |
| **缓存策略** | Cache-aside            | 读：KV → 未命中 → D1 → 回填 KV。写：失效相关 KV key |

---

## 前置要求

- [Node.js](https://nodejs.org/) 22.18+（[`cf` CLI](https://developers.cloudflare.com/cf/) 的要求）
- 一个 [Cloudflare](https://cloudflare.com) 账号，需具备：
  - Workers 订阅（免费计划可用）
  - D1 数据库配额
  - KV namespace 配额

## 部署

### 1. 克隆并安装

```bash
git clone https://github.com/jyfzh/current
cd current
npm install
```

### 2. 配置 cloudflare.config.ts

`cloudflare.config.ts` 是 Worker 的配置来源：绑定、每小时 cron 触发器和运行时变量。项目是纯 JavaScript，无需用户编写构建脚本 —— `npm run build`（`cf build`）会通过 Cloudflare Vite 插件用 Vite 打包 `src/index.js`。

`vite.config.ts` 配置打包器和本地开发服务器端口（默认 `8787`）。

### 3. 部署到生产环境

#### 3a. 创建远程 D1 数据库

```bash
npx cf d1 create --name current-db
```

该命令会输出一个数据库 ID。将其复制到 `cloudflare.config.ts` 的 `DB` 绑定：

```ts
DB: bindings.d1({
  id: "<数据库-ID>",
}),
```

#### 3b. 创建远程 KV namespace

```bash
npx cf kv namespaces create --title current-cache
```

将输出的 namespace ID 复制到 `cloudflare.config.ts` 的 `CACHE` 绑定：

```ts
CACHE: bindings.kv({
  id: "<namespace-ID>",
}),
```

#### 3c. 初始化远程数据库

```bash
npx cf d1 migrations apply <数据库-ID> --dir migrations
```

#### 3d. 设置 secrets

创建一个 `.secrets` 文件（已被 gitignore 忽略），使用 `.env` 格式：

```bash
cat > .secrets <<'EOF'
CURRENT_FEVER_PASSWORD=<你的密码>
CURRENT_FEVER_EMAIL=<你的邮箱>
EOF
```

这两个名称已在 `cloudflare.config.ts` 中声明为必需 secret。通过 `--secrets-file` 上传：

```bash
npx cf deploy --secrets-file .secrets
```

以后轮换 secret 时，更新 `.secrets` 并用相同参数部署；或用 `npx cf workers secrets update CURRENT_FEVER_PASSWORD --text <值> --worker current` 单独设置。

#### 3e. 部署

```bash
npx cf auth login   # 仅首次需要
npm run deploy      # 或：npx cf deploy
```

部署后，你的 API 地址为：

```
https://current.<你的子域名>.workers.dev/?api
```

### 4. 验证

```bash
curl "https://current.<你的子域名>.workers.dev/?api&api_key=$(echo -n '<邮箱>:<密码>' | md5sum | cut -d' ' -f1)"
```

预期返回：

```json
{"api_version":3,"auth":1}
```

---

## 配置

所有配置通过 Worker 环境变量进行，在 `cloudflare.config.ts` 中用 `bindings.text(...)`（普通变量）或 `bindings.secret()`（secrets）声明：

### Secrets（必填）

| 变量 | 描述 |
|----------|------|
| `CURRENT_FEVER_PASSWORD` | Fever API 密码（与邮箱一起用于认证） |
| `CURRENT_FEVER_EMAIL` | Fever API 邮箱（默认值：`admin`，与密码一起用于认证） |

### 运行时变量（全部可选，有默认值）

| 变量 | 默认值 | 描述 |
|----------|--------|------|
| `CURRENT_MAX_CONCURRENCY` | `5` | 最大并发订阅源抓取数（`0` = 无限制） |
| `CURRENT_FEED_STALE_SECONDS` | `3600` | 订阅源可重新抓取的最小间隔（秒） |
| `CURRENT_STARTUP_FETCH` | `true` | 部署后首次 HTTP 请求时触发全量订阅源抓取 |
| `CURRENT_CACHE_TTL_AGGREGATE` | `600` | 聚合查询（总条目数、分组计数）的 KV 缓存 TTL |
| `CURRENT_CACHE_TTL_STRUCTURAL` | `600` | 结构数据（订阅源、分组、未读/收藏 ID）的 KV 缓存 TTL |
| `CURRENT_FEVER_ITEMS_PER_PAGE` | `50` | API 响应每页条目数 |

---

## 使用 —— 连接 RSS 客户端

Current 使用 **Fever API 协议**，因此任何支持 Fever 同步的 RSS 阅读器都可以连接。

### 通用设置

1. 打开 RSS 客户端的账户/同步设置
2. 选择 **Fever** 作为同步类型
3. 填入：
   - **URL**：`https://current.<你的子域名>.workers.dev/?api`
   - **Email**：你在 `CURRENT_FEVER_EMAIL` 中设置的值（默认 `admin`）
   - **Password**：你在 `CURRENT_FEVER_PASSWORD` 中设置的值

### 添加订阅源

推荐打开服务根路径 `/` 或 `/admin`，使用 `CURRENT_FEVER_EMAIL`（默认 `admin`）和 `CURRENT_FEVER_PASSWORD` 登录中文管理面板。

管理面板支持：

- 添加、编辑、删除订阅源；按名称或 URL 搜索，按分组和 HTTP 状态筛选。
- 新建、重命名、删除分组；删除分组会将订阅源移至「未分组」。
- 查看订阅数、分组数、未读文章数、最近抓取时间及 HTTP 状态；手动刷新单个订阅源。
- 删除订阅源时，一并删除其文章、收藏和阅读记录，操作前需要确认。

管理接口位于 `/admin/api/`，与现有 `/?api` Fever 协议独立。登录凭据仅保留在当前页面内存，刷新页面需要重新登录；生产环境请通过 HTTPS 访问。HTTP 正常不代表内容一定解析成功，解析详情请查看服务日志。无需新增数据库迁移或运行时依赖。

如果需要批量维护，也可以直接操作 D1 数据库：

你可以通过以下任一方式对 D1 数据库执行 SQL：

#### Cloudflare Dashboard（D1 UI）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 **Workers & Pages** → **D1** → 选择你的数据库
3. 使用 **Explorer Data** 标签页交互式运行 SQL 查询，或直接通过 UI 查看、添加、删除行

#### cf CLI

```bash
# 直接执行 SQL（使用 `cf d1 create` 输出的数据库 ID）
npx cf d1 raw <数据库-ID> --sql "INSERT INTO groups (title) VALUES ('技术');"

# 以 batch 方式执行 SQL 文件
npx cf d1 raw <数据库-ID> --batch @queries.json
```

`queries.json` 是查询对象组成的 JSON 数组：

```json
[
  {
    "sql": "INSERT INTO feeds (title, url, site_url, group_id) VALUES ('示例博客', 'https://example.com/rss', 'https://example.com', 1);"
  }
]
```

添加订阅源的 SQL 示例：

```sql
-- 添加分组
INSERT INTO groups (title) VALUES ('技术');

-- 添加订阅源
INSERT INTO feeds (title, url, site_url, group_id)
VALUES ('示例博客', 'https://example.com/rss', 'https://example.com', 1);
```

下次定时任务运行时（或首次 API 请求时，若 `CURRENT_STARTUP_FETCH` 已启用）将抓取并填充条目。

### 标记为已读

在 RSS 客户端中，选择订阅源/分组并使用"标记为已读"功能。客户端会发送对应的 `mark=feed&as=read&id=N&before=TS` 命令，由 Current 处理。

---

## API 参考

Fever API 协议的完整文档见 [`docs/fever-api.md`](docs/fever-api.md)，OpenAPI 规范见 [`docs/fever-openapi.yaml`](docs/fever-openapi.yaml)。

---

## 技术栈

| 层       | 技术                                          |
|----------|-----------------------------------------------|
| 语言     | JavaScript（ES modules）                      |
| 运行时   | Cloudflare Workers                            |
| 工具链   | [`cf`](https://developers.cloudflare.com/cf/)（Cloudflare CLI，beta） |
| 数据库   | Cloudflare D1（兼容 SQLite）                  |
| 缓存     | Cloudflare KV                                |
| 订阅源解析 | 内置解析器（RSS 2.0, Atom, JSON Feed）        |
| 认证     | MD5（Fever 协议）                             |
| 调度     | Workers Cron Triggers                        |

---

## 路线图

- **AI 订阅源聚类** — 使用 [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) 嵌入和 [Vectorize](https://developers.cloudflare.com/vectorize/) 自动将订阅源归入主题分类（如技术、科学、政治），无需手动设置即可为新订阅进行分类。
- **个性化推荐** — 基于你的阅读历史，通过 Workers AI 推理引擎推送热门或相关内容。
- **智能摘要** — 使用运行在 Workers AI 上的 LLM 为未读条目生成简洁摘要，存回 D1 以便快速回顾。
- **热点发现** — 分析所有订阅源的标题和内容，识别新兴话题和报道热点，以新的 API 端点形式提供。

> 以上功能将利用 Cloudflare 的全球 AI 推理网络，使数据处理靠近数据库，最大限度降低延迟。

---

## 许可证

[MIT](LICENSE) © 2026 jyfzh
