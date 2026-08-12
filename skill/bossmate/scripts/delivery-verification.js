function verifyFrom(value) {
  const rows = Array.isArray(value) ? value : [value];
  const verify = rows.find(x => x && x.verify)?.verify || value?.verify || {};
  return {
    inputEmpty: verify.inputEmpty === true,
    hasMyMsg: verify.hasMyMsg === true,
    hasSongda: verify.hasSongda === true,
  };
}

function buildDeliveryVerifyExpr(msgExpr, targetBossIdExpr, companyExpr) {
  return `(async()=>{
   try {
    const msg=${msgExpr};
    const targetBossId=${targetBossIdExpr};
    const findMatches=()=>{
      let vm=document.querySelector('.friend-content-warp')?.__vue__;
      while(vm&&vm.$options?.name!=='virtual-list')vm=vm.$parent;
      const sources=vm?.$props?.dataSources||vm?.dataSources||[];
      return targetBossId?sources.filter(s=>s&&String(s.encryptBossId||'')===targetBossId):[];
    };
    let matches=[],entry,confirmed=false;
    for(let attempt=0;attempt<15;attempt++){
      matches=findMatches();
      entry=matches[0];
      confirmed=!!(entry&&entry.lastIsSelf&&(entry.lastText||'').trim()===msg);
      if(confirmed)break;
      if(attempt<14)await new Promise(r=>setTimeout(r,1000));
    }
    const input=document.querySelector('#chat-input');
    return {
      inputEmpty:!input||(input.innerText||'').trim()==='',
      identityMatchCount:matches.length,
      matchedText:confirmed,
      readOrDelivered:confirmed?Number(entry.lastMsgStatus)>=1:false,
      companyVisible:document.body.innerText.includes(${companyExpr})
    };
   } catch (e) {
     return { error: 'js-exception: ' + (e && e.message || String(e)) };
   }
  })()`;
}

function sentVerification(sent) {
  return {
    inputEmpty: sent?.inputEmpty === true,
    identityMatched: sent?.identityMatchCount === 1 && sent?.matchedText === true,
    delivered: sent?.readOrDelivered === true,
    companyVisible: sent?.companyVisible === true,
  };
}



module.exports = { verifyFrom, buildDeliveryVerifyExpr, sentVerification };
