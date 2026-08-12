# 运行时架构

仅在维护、扩展或排查 BossMate 本身时阅读本文件。日常求职任务不需要加载。

## 入口与依赖方向

`scripts/boss.js` 是稳定命令入口，负责命令编排和仍待继续拆分的在线流程；它不再承担存储、参数解析或可复用的岗位/JD 规则。

```text
boss.js
├─ runtime-config.js       私有工作区路径与用户配置
├─ cli-args.js             选项、标记和位置参数解析
├─ ledger-store.js         写锁、旧快照冲突检测、原子替换
├─ safety.js               按账号熔断锁、滚动额度与随机节奏
├─ job-domain.js           岗位归一化、方向匹配、初筛与招聘者去重
├─ jd-domain.js            JD 解析、归一化、哈希与旧结构恢复
├─ opener-service.js       审核载荷、开场白上下文与发送资格
├─ delivery-verification.js 消息身份与送达证据
├─ conversation-domain.js 会话分类与简历触发语义
├─ daily-options.js        当天简历策略（按账号、按日期）
├─ workbench.js            单岗状态、下一项工作与离线审核巡检
├─ offline-commands.js      审核、文案、公司、额度等离线命令编排
├─ discovery-sources.js     收藏与推荐职位的分页、断点和来源写入
├─ page-flows.js           岗位页面读取表达式和页面状态判断
├─ command-help.js         命令说明与帮助覆盖检查
├─ maintenance.js          历史导入与离线台账校验
└─ cdp.js                  裸 CDP 连接、标签、超时和导航回读
```

依赖只能从 `boss.js` 指向下层模块，下层模块不得反向加载入口。领域模块不连接浏览器，存储模块不判断岗位是否适合。个人事实和求职偏好只能保存在用户私有工作区，不能复制进 Skill 包。

## 排障入口

- 连接、标签、导航或执行超时：`cdp.js`
- 熔断、额度、随机节奏或连续空白 JD：`safety.js`
- 台账写入丢失或并发冲突：`ledger-store.js`
- 岗位方向、初筛或招聘者去重错误：`job-domain.js`
- JD 解析或哈希误报变化：`jd-domain.js`
- 审核上下文、开场白或发送资格：`opener-service.js`
- 送达误判或漏判：`delivery-verification.js`
- 会话分类或简历触发误判：`conversation-domain.js`
- 每日简历策略：`daily-options.js`
- 下一项工作或单岗聚合错误：`workbench.js`
- 岗位页面加载、关闭或失效判断：`page-flows.js`
- 命令参数顺序或选项解析：`cli-args.js`
- 命令无法发现或帮助失效：`command-help.js`
- 升级、历史导入或台账校验：`maintenance.js`

修改后运行 `node scripts/boss.js doctor`。公开默认值必须保持中立：地点、办公方式、报酬、目标岗位和排除项都来自每位用户自己的 `preferences.json`，不能固化在源码中。

## 与私有工作流的边界

私有工作流验证过的新机制，应先判断能否大众化再同步：

- 可以直接通用化：原子台账写入、参数解析、CDP 稳定性、页面状态、会话分类、工作台和诊断。
- 需要配置化：简历文件与岗位方向映射、开场白格式、地点/远程要求、搜索入口优先级。
- 不得复制：用户名、简历文件名、个人作品集、固定开场白、私人求职周期和真实台账。

`daily-options` 目前只记录每日策略并公开多简历配置，不执行附件自动发送；在通用版完成附件唯一定位、对方明确触发、重复发送检查和送达回写前，不得把该能力描述为已完成。
