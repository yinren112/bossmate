const { SECURITY_JS_EXPR } = require('./safety');

const isClosedJobText = text => /职位已关闭|职位已下线|招聘已结束/.test(String(text || ''));

function unreadableJobMessage(page) {
  const body = String(page?.bodyText || '');
  return /登录查看完整内容|登录后查看完整职位描述|请登录/.test(body)
    ? '登录态失效或职位正文受登录限制，已停止'
    : 'JD 正文在 12 秒内未渲染，已停止';
}

function isExpiredJobRedirect(url) {
  try {
    const parsed = new URL(String(url || ''));
    return /(^|\.)zhipin\.com$/.test(parsed.hostname) &&
      (parsed.pathname === '/' || parsed.pathname === '' || /^\/web\/geek\/jobs?\/?$/.test(parsed.pathname));
  } catch {
    return false;
  }
}

function jobPageExpression() {
  return `(()=>{
    const text=(el)=>(el?.innerText||'').replace(/\\s+/g,' ').trim();
    const section=(name)=>{
      const heading=[...document.querySelectorAll('.job-detail h2,.job-detail h3,.job-detail .job-sec-title')].find(x=>text(x)===name);
      const box=heading?.closest('.detail-section-item,.job-detail-section,.job-sec,.job-box')||heading?.parentElement;
      return box ? text(box).replace(name,'').trim() : '';
    };
    const b=document.querySelector('.btn-startchat');
    const description=text(document.querySelector('.job-sec-text'));
    const primary=text(document.querySelector('.job-primary'));
    const recruiterBox=document.querySelector('.job-boss-info');
    const recruiterNameEl=recruiterBox?.querySelector('.name');
    const recruiterState=text(recruiterBox?.querySelector('.boss-active-time,.boss-online-tag'));
    const recruiterName=recruiterNameEl ? text(recruiterNameEl).replace(recruiterState,'').trim() : '';
    const recruiterAttr=text(recruiterBox?.querySelector('.boss-info-attr'));
    const attrParts=recruiterAttr.split('·').map(x=>x.trim()).filter(Boolean);
    const bodyText=document.body?.innerText||'';
    const salary=(description.match(/\\d+(?:\\.\\d+)?-\\d+(?:\\.\\d+)?(?:K(?:·\\d+薪)?|元\\/(?:时|天|月))/i)||bodyText.match(/\\d+(?:\\.\\d+)?-\\d+(?:\\.\\d+)?(?:K(?:·\\d+薪)?|元\\/(?:时|天|月))/i)||[])[0]||'';
    return JSON.stringify({
      url:location.href,bodyText,security:${SECURITY_JS_EXPR},
      structured:{
        title:document.querySelector('.job-banner h1[title]')?.getAttribute('title')||text(document.querySelector('.job-banner h1')),
        company:attrParts[0]||'',salary,description,
        benefits:[...new Set([...(document.querySelector('.job-tags')?.querySelectorAll('span,li')||[])].map(text).filter(Boolean))].join('、'),
        companyIntroduction:section('公司介绍'),businessInformation:section('工商信息'),address:section('工作地址'),
        experience:(primary.match(/经验不限|应届生|\\d+-\\d+年|\\d+年以上/)||[])[0]||'',
        education:(primary.match(/学历不限|初中|中专|高中|大专|本科|硕士|博士/)||[])[0]||'',
        tags:[...new Set([...(document.querySelector('.job-tags')?.querySelectorAll('span,li')||[])].map(text).filter(Boolean))],
        recruiter:{name:recruiterName,title:attrParts.slice(1).join(' · '),activeText:recruiterState},
        incomplete:/登录查看完整内容|登录后查看完整职位描述/.test(description)
      },
      button:{text:text(b),redirectUrl:b?.getAttribute('redirect-url')||'',isFriend:b?.dataset?.isfriend||''}
    });
  })()`;
}

async function waitForSearchResults(cdp, timeoutMs = 18000, previousSignature = '') {
  const deadline = Date.now() + timeoutMs;
  let state = {};
  while (Date.now() < deadline) {
    state = await cdp.eval(`(()=>{const body=(document.body?.innerText||'').replace(/\\s+/g,' ').trim();const real=a=>/\\/job_detail\\/[\\w~-]+\\.html(?:[?#]|$)/.test(a.href)&&a.offsetParent!==null&&!a.closest('header,.zp-header,footer,.footer');const ids=[...new Set([...document.querySelectorAll('a[href*="/job_detail/"]')].filter(real).map(a=>(a.href.match(/job_detail\\/([\\w~-]+)\\.html/)||[])[1]).filter(Boolean))];return {url:location.href,security:${SECURITY_JS_EXPR},count:ids.length,ids,signature:ids.join('|'),empty:/暂无相关职位|没有找到相关职位|暂无职位|换个关键词/.test(body)}})()`);
    if (state.security || state.empty || (state.count > 0 && (!previousSignature || state.signature !== previousSignature))) return state;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return state;
}

module.exports = { isClosedJobText, unreadableJobMessage, isExpiredJobRedirect, jobPageExpression, waitForSearchResults };
