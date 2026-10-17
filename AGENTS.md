# 二次元女友（Desktop Companion）

Windows 桌面陪伴应用：Q 版角色常驻桌面，独立聊天窗口。人设回复、自动记忆、纠正/忘记是第一版核心；静态图片，无语音与动作。

本项目同时是**从零开始的学习项目**：一切以可理解、可跟进为先。规格位于 `docs/sdd/`（01～09），当前阶段见 `docs/sdd/06-开发执行计划.md`。

## Working Style

- IMPORTANT：任何阶段、任何功能的任务，动手写代码前先拆成最小步骤清单，再逐步实现
- 一次只做一个可运行、可验证的小改动，确认后再继续下一步
- 单次变更小到可以逐行读懂；每步附一句说明：改了什么、为什么
- 不为赶进度把多个步骤合并成一次大改动

## Repository Structure

- `docs/sdd/` — 全套规格文档，需求的唯一权威来源
- `output/design/` — 角色形象设计稿
- `app/` — 应用工程；内部结构按 03 §4：`src/`（desktop/bridge/ui/service/agent/memory/data/jobs/shared）+ `characters/`（角色样稿，不放密钥）+ `tests/`

任务与必读规格对照：需求与架构 01/03，角色与记忆 02/07，数据与迁移 05，任务拆分 06，换方案 08 §4～§5，审查未结事项 09（H2 聊天费用上限、F3 开机自启动、F4 版权均未决，不得擅自替用户决定）。

## Hard Invariants

- SQLite 是用户数据的唯一权威记录；eve 运行文件可丢弃重建，不得作为聊天或记忆依据（05 §1、08 D08）
- 试聊（preview）与正式记忆的隔离由服务层代码强制，不能只靠提示词约束（04 §2、09 H1）
- 工具执行成功才向用户报告成功；失败不假装成功，重试不重复写入（01 R17、04 §9）
- 日志只记操作 ID、错误码、耗时与用量；不记对话原文、完整提示词或密钥（03 §7）
- 不凭记忆虚构 eve / AI SDK 的 API；以实际安装版本的官方文档为准（03 §3、04 §3）

## Tech Stack

TypeScript · Electron · React · electron-vite · eve · AI SDK · Zod · SQLite（Drizzle + better-sqlite3）· Vitest · electron-builder(NSIS)

技术选型是固定基线，详见 `docs/sdd/03`；精确版本以 `docs/sdd/08` 实测记录为准；不引入清单外的框架或库。

记忆检索首版只用中文关键词（Intl.Segmenter + 精确匹配）；不得擅自引入 embedding、向量库或 RAG 方案——语义检索是规格预留项，启用前必须走 `docs/sdd/08` §5 变更决策（V05）。

## Setup Commands

```bash
nvm list             # 确认 24.10.0 生效（eve 要求 Node >= 24）
cd app
npm ci
```

执行命令前检查目录和脚本是否存在。Node 版本不符时停下告知用户手动切换，不自行处理。新增依赖先列清单，经用户批准后安装。

## Build and Test Commands

```bash
node docs/sdd/validate-spec.mjs   # 规格一致性 + 内存库结构检查（修改 docs/sdd 后必跑）

cd app
npm test             # Vitest 单元与流程检查
npm run dev          # 开发运行
npm run build:win    # electron-builder 打 NSIS 安装包
```

## Code Style

- TypeScript strict 模式；标识符英文，注释与用户可见文案中文
- 注释是硬性要求，覆盖本项目所有源文件（包括代理新建与生成的每一个）：文件头注明该文件职责；公开函数/类写 JSDoc（用途、参数、返回）；非直观逻辑加行内注释解释意图
- 注释用大白话，读者设定为 TypeScript 初学者：先说「这段代码防什么事故、解决什么问题」，再讲怎么做；能用具象场景（谁在读、谁在写、删了哪条会怎样）就不用抽象术语
- 必须用的术语（事务、外键、流等）就地用一句话解释；规格编号（如 05 §1）只作句尾补充出处，正文脱离规格也要能读懂
- 改动代码时同步更新受影响的注释；过时的注释比没有注释更误导
- 优先直白、易读的写法，不炫技
- React 组件用 CSS Modules；不引入规格外的框架

## Testing Instructions

- 数据与流程逻辑用 Vitest；透明窗口、安装、休眠等做真机手工验收
- 自动检查用固定输入与模拟模型输出，不用概率性真实回复测数据库正确性（07 §3）
- 角色评价必须人工参与；只有模型自动评分不算通过（07 §5）
- 宣称「已验证」必须附实测证据（命令输出、截图、精确版本号），按 06 §7 模板记录任务证据，版本类结论写入 08
- 不降低 `docs/sdd/07` 的验收门槛

## Commit Guidelines

- Conventional Commits：`feat:` `fix:` `docs:` `chore:`，描述用中文
- 只在用户要求时提交；未经许可不 push、不建远程
- 提交前确认不含密钥、node_modules、构建产物

## Security Requirements

- API 密钥与会话令牌：不进 git、不进命令行参数、不进环境变量、不进日志；只按 `docs/sdd/03` §3 的 stdin/令牌通道交付
- 不上传用户数据到任何云服务；界面进程无 Node 能力、无直接数据库访问（03 §7）

## Additional Rules

- 下载依赖、修改 `docs/`、调用付费模型 API，须先获用户对本次操作的批准；用户明确要求执行该操作时，无须重复询问
- 系统环境只读：不切 nvm、不装全局工具、不动仓库外的 Node 副本（`C:\nvm4w`、`D:\web-projects\nodejs`）
- 行为变更必须同步更新规格文档（08 §5 变更流程）
- 本文件与规格冲突时，停下询问用户，不自行取舍
