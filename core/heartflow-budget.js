const {randomUUID}=require('crypto');
const DEFAULT_DAILY_BUDGET=500000;
function budgetDay(now) { return new Date(now).toISOString().slice(0,10); }
function usageStatus(state,now=Date.now()) {
  const day=budgetDay(now), ledger=state.modelUsage?.[day]||{};
  const limit=state.config.dailyTokenBudget??DEFAULT_DAILY_BUDGET;
  const used=(ledger.inputTokens||0)+(ledger.outputTokens||0)+(ledger.estimatedTokens||0);
  const reserved=Object.values(ledger.reservations||{}).reduce((a,b)=>a+b.tokens,0);
  const remaining=Math.max(0,limit-used-reserved),blocked=state.source.budgetBlocked;
  return {day,timeZone:'UTC',limit,used,reserved,paused:remaining===0||(blocked?.day===day&&remaining<blocked.required),remaining,inputTokens:ledger.inputTokens||0,outputTokens:ledger.outputTokens||0,cachedTokens:ledger.cachedTokens||0,estimatedTokens:ledger.estimatedTokens||0,calls:ledger.calls||0,byMode:ledger.byMode||{}};
}
function trackedAnalysis({store,analyze,now=Date.now}) {
  return async(context,model)=>{
    const {requestBudget,MAX_OUTPUT_TOKENS}=require('./heartflow-model');
    const reserve=requestBudget(context),day=budgetDay(now()),id=randomUUID(),mode=context.mode||'suggest';
    if(Buffer.byteLength(JSON.stringify(context))>64000)throw Object.assign(new Error('话题上下文超过单次上限，请拆分建议后核对；未执行行动'),{code:'CONTEXT_LIMIT'});
    try { store.transaction(s=>{
      const usage=usageStatus(s,now());
      if(usage.remaining<reserve)throw Object.assign(new Error('今日助理预算不足，继续接收消息；模型分析及确认前核对暂停，可调整预算后继续'),{code:'BUDGET_EXHAUSTED'});
      s.modelUsage??={};
      const row=s.modelUsage[day]??={inputTokens:0,outputTokens:0,estimatedTokens:0,cachedTokens:0,calls:0,reservations:{},byMode:{}};
      row.reservations[id]={tokens:reserve,at:now(),mode};
      // Retain reservations across restarts: unknown outcomes must not free budget.
      for(const key of Object.keys(s.modelUsage).sort().slice(0,-32))delete s.modelUsage[key];
    }); } catch(error) {
      if(error.code==='BUDGET_EXHAUSTED')store.transaction(s=>{s.source.budgetBlocked={day,required:reserve};});
      throw error;
    }
    let usage,result;
    try { result=await analyze(context,model,{maxOutputTokens:MAX_OUTPUT_TOKENS,onUsage:value=>{usage=value;}});usage??=result?.usage;return result; }
    finally {
      store.transaction(s=>{
        const row=s.modelUsage[day];if(!row?.reservations[id])return;
        delete row.reservations[id];row.calls++;
        const actual=usage&&Number.isFinite(usage.input_tokens)&&Number.isFinite(usage.output_tokens)&&usage.input_tokens>=0&&usage.output_tokens>=0;
        const charged=actual?usage.input_tokens+usage.output_tokens:reserve;
        if(actual){row.inputTokens+=usage.input_tokens;row.outputTokens+=usage.output_tokens;row.cachedTokens+=usage.input_tokens_details?.cached_tokens||usage.cache_read_input_tokens||0;}else row.estimatedTokens+=reserve;
        const bucket=row.byMode[mode]??={calls:0,tokens:0};bucket.calls++;bucket.tokens+=charged;
      });
    }
  };
}
module.exports={trackedAnalysis,usageStatus,DEFAULT_DAILY_BUDGET};
