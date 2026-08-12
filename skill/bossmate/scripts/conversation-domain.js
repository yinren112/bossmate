function conversationStatus(item) {
  const ours = /status/.test(item.statusClass || '');
  if (ours) return /read/.test(item.statusClass) ? 'ours_last_read' : 'ours_last_delivered';
  const message = String(item.lastMessage || '');
  if (!message.trim()) return 'needs_inspect';
  if (/您的附件简历.*已发送给Boss|对方已同意，您的附件简历已发送给对方|附件简历请求已发送/.test(message)) return 'system_notice';
  if (/的(?:微信号|手机号)[：:]/.test(message)) return 'contact_shared';
  if (/^(?:不好意思|不可以)[啊哦]?$|不.{0,2}合适|不接受|不考虑|暂不|抱歉|对不起|已招到|停止招聘|不(?:支持|接受|可以)远程|早日找到/.test(message)) return 'closed';
  if (/[?？]|多少|是否|能否|有没有|了解过|做过|会不会|怎么|怎样|如何|哪[些个]|多久|几(?:年|个|月)|什么|吗(?:[啊呢呀]?$)|(?:最近|现在|目前)?还(?:在)?考虑不|还在看(?:机会|工作)|加.{0,4}(微信|手机号)|发.{0,6}(简历|作品|样片|案例)|看下|提供|方便|可以|聊一聊|聊聊|有兴趣|进一步沟通/.test(message)) return 'needs_reply';
  return 'boss_last_review';
}

function currentConversations(ledger) {
  const syncAt = ledger.conversationSyncAt;
  return syncAt ? (ledger.conversations || []).filter(item => item.checkedAt === syncAt) : (ledger.conversations || []);
}

function resumeTrigger(message) {
  const text = String(message || '');
  if (!text.trim()) return 'inspect';
  if (/^(?:不好意思|不可以)[啊哦]?$|不.{0,2}合适|不接受|不考虑|暂不|抱歉|对不起|已招到|停止招聘|不(?:支持|接受|可以)远程|早日找到/.test(text)) return 'closed';
  if (/附件简历.*已发送|已发送给Boss|已发送给对方/.test(text)) return 'already_sent';
  if (/(?:不用|不需要|无需|先别|暂时不(?:用|要)).{0,8}(?:发|发送|提供)?.{0,5}(?:简历|附件)|(?:简历|附件).{0,8}(?:不用|不需要|无需|先别|暂时不(?:用|要))/.test(text)) return 'declined';
  if (/简历|附件|发我|发一份|看下资料|资料发/.test(text)) return 'explicit';
  if (/聊一聊|聊聊|有兴趣|进一步沟通|可以沟通|方便沟通|介绍一下/.test(text)) return 'positive';
  return 'review';
}

module.exports = { conversationStatus, currentConversations, resumeTrigger };
