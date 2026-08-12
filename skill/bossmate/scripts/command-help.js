const HELP = {
  doctor: '完全离线检查 Node、模块、私有工作区、台账和自测',
  preflight: '汇总熔断、浏览器、额度、每日策略和工作队列',
  'daily-options': '查看或记录当天简历策略：--resume=off|explicit|positive',
  'next-work': '离线返回当前最值得继续的一项工作',
  'job-workbench': '离线查看单个岗位完整状态与下一条命令',
  'review-audit': '离线检查审核证据、JD 和开场白一致性',
  'job-sources': '离线汇总岗位来源入口',
  favorites: '读取一页收藏岗位并维护完整快照',
  'favorites-next': '继续收藏岗位分页扫描',
  'favorite-status': '离线查看当前收藏的首次联系状态',
  'favorite-queue': '离线查看当前收藏中尚未首次联系的岗位',
  recommendations: '从推荐职位入口读取第一批岗位',
  'recommendations-next': '继续推荐职位流并在到底时收尾',
  'recommendations-close': '关闭推荐职位专用标签并清理断点',
  check: '检查专用浏览器登录与安全页面',
  replies: '同步完整会话列表并分类待回复项',
  interactions: '同步谁看过我和对我感兴趣的岗位入口',
  profile: '读取在线简历摘要和附件名称',
  profiles: '列出私有配置中的岗位方向',
  search: '搜索一页岗位并写入台账',
  'search-next': '在同一标签中真正翻页或滚动加载下一批搜索结果',
  'search-close': '关闭搜索专用标签并清理续跑断点',
  candidates: '离线列出待读完整 JD 的候选',
  read: '在线读取一个岗位的完整 JD',
  jd: '离线返回一个已读取岗位的审核材料',
  review: '记录岗位方向、地点、报酬和风险审核证据',
  'opener-context': '返回编写定制开场白所需上下文',
  'save-opener': '校验并保存 MSG 环境变量中的开场白',
  'discard-opener': '丢弃已过时或不满意的开场白',
  send: '通过全部门禁后发送已保存的开场白',
  'verify-delivery': '重新核验 delivery_unverified 的目标消息',
  company: '离线查看公司记录',
  'company-jobs': '在线读取同一公司的岗位入口',
  list: '离线筛选和查看台账队列',
  'rate-status': '离线查看滚动额度与节奏',
  budget: 'rate-status 的简短别名',
  import: '离线导入旧版工作区数据',
  'migrate-jd': '离线把旧版 JD 文本迁移为结构化字段',
  'rehash-jd': '离线迁移规范化后的 JD 哈希',
  validate: '离线校验台账结构和关键状态',
  'self-test': '运行确定性运行时自测',
  unlock: '人工确认后解除当前端口熔断锁',
};

function help(command = '') {
  if (command) {
    if (!HELP[command]) throw new Error(`未知命令 ${command}`);
    console.log(`${command}\n  ${HELP[command]}`);
    return;
  }
  console.log('用法: node scripts/boss.js <command> [options]\n');
  for (const [name, description] of Object.entries(HELP)) console.log(`${name.padEnd(18)} ${description}`);
}

module.exports = { HELP, help };
