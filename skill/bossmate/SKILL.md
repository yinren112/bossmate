---
name: bossmate
description: 通过用户本人登录的 Edge 或 Chrome 浏览器和裸 CDP，执行本地、证据驱动的 BOSS 求职工作流。用户需要从简历初始化求职偏好、启动专用浏览器、搜索和读取完整 JD、审核岗位方向/地点/报酬/风险、避免重复联系招聘者、编写真实开场白、发送并核验送达，或继续和审计已有 BossMate 工作区时，应使用本 Skill。Use this skill for local evidence-based BOSS job search, outreach, delivery verification, workspace continuation, and runtime maintenance.
---

# BossMate

作为用户的求职协作代理运行。随 Skill 提供的脚本负责确定性的浏览器控制、台账、去重、发送门禁和送达核验；当前宿主 Agent 负责判断和写作，不得在用户不知情时调用另一个 AI 产品。

## 定位私有工作区

优先使用 `BOSSMATE_HOME`，兼容 `BOSS_JOB_HOME`。均未设置时使用：

- Windows：`%USERPROFILE%\.bossmate`
- macOS/Linux：`$HOME/.bossmate`

不得把简历、浏览器 Profile、聊天记录或真实台账存入 Skill 目录。

## 按任务加载说明

1. 缺少 `profile.md` 或 `preferences.json`：阅读 [references/onboarding.md](references/onboarding.md) 完成初始化。
2. 专用浏览器未启动或未登录：阅读 [references/browser.md](references/browser.md)。
3. 执行求职流程：阅读 [references/workflow.md](references/workflow.md)。
4. 进行任何在线或发送动作前：应用 [references/safety.md](references/safety.md)。
5. 只有修改额度、增加在线动作或判断节奏是否异常时，才阅读 [references/rate-limit-rationale.md](references/rate-limit-rationale.md)。
6. 维护、排障或扩展运行时代码时，先阅读 [references/architecture.md](references/architecture.md)。

## 不可妥协的规则

- 登录必须由用户本人完成；不得索要或处理密码、短信验证码、Cookie 或会话令牌。
- 只使用随包提供的 `scripts/cdp.js` 浏览器链路，不改用 Playwright、扩展、内部接口或直接站点请求。
- 在线动作一次只执行一个，不并行操作账号、搜索、JD 读取或发送。
- 完整读取 JD 后才能做最终判断，并保存岗位方向、地点/办公方式、报酬和风险的原始证据。
- 招聘者身份和历史会话是硬去重门禁；开场白只能使用用户在 `profile.md` 中确认的事实。
- 不得重置或绕过发送状态；运行时不提供强制发送入口。
- 只有同一条完整消息绑定本人消息行，且该行显示送达或已读，才能记为送达。
- 验证码、403、passport 异常、账号异常、code 32/36/37、连续空白 JD、滚动额度硬顶、收件人不明确或送达不确定时，立即停止并写入 `lock.<port>.json`。人工解除前，该账号的在线命令全部拒绝运行。
- 搜索、详情读取和发送使用 24 小时滚动窗口、10 分钟突发上限和随机最小间隔；不得把随机等待改成固定等待。
- 不得直接读取 `data/ledger.json`。使用 `read --jd`、`jd`、`preflight`、`list`、`candidates` 和 `rate-status` 获取所需字段。
- 每个 JD 只在线读取一次，审核记账后从当前上下文丢弃；每轮建议处理约 15–20 个岗位。

## Agent 与脚本的职责

Agent 负责采访用户、更新私有配置、判断完整 JD、记录证据、基于已确认事实写定制开场白，并从台账而非聊天记忆报告进度。

脚本负责裸 CDP 控制、台账原子写入、按账号熔断与额度、招聘者去重、关闭岗位识别、实时 JD/招聘者/消息/送达核验，以及拒绝对象不明确或不安全的动作。

## 完成条件

只有满足以下条件才能结束：

1. 修改运行时代码后 `node scripts/boss.js doctor` 通过；处理岗位后 `validate` 通过。
2. `check` 确认存在已登录的正常 BOSS 页面且没有安全页。
3. 所有 `delivery_unverified` 均已运行 `verify-delivery`，或明确报告仍未核实。
4. 每个已处理岗位都已在台账记录证据和结果。
5. 最终报告分别列出已送达、已跳过、已淘汰、待处理和被阻塞项目。

没有岗位通过时如实报告 0，不得为了数量降低用户规则。
