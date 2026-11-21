// Conservative lexical gate, not a general natural-language authorization parser.
// A real owner + PR link authorizes neither persistent work nor overriding a one-shot request.
export const withoutPrUrls = (text: string): string => text.replace(/https?:\/\/[^\s<>"'`，。；！？）)\]]+/gi, ' ');

export function hasExplicitPrWatchIntent(text: string): boolean {
  const words = withoutPrUrls(text);
  if (/[?？]|哪些|多少|什么|如何|怎么|是否|\b(?:which|what|how|list|show)\b/i.test(words)) return false;
  const oneShot = /(?:只|仅)(?:看|查|检查|查询|验证)?(?:这)?(?:一次|一遍|一回|这次|本次)|(?:不要|不用|无需|不需要|不想|不是|别|停止|取消)[^，。！？；\n]{0,16}(?:跟进|跟踪|监控|订阅|盯|提醒|通知|关注|检查)|不(?:再|必)?(?:持续|继续|长期|自动)?(?:跟进|跟踪|监控|订阅|盯|提醒|通知|关注|检查)/.test(words)
    || /\b(?:check|look|query|inspect|fetch)\b[^.!?\n]{0,16}\b(?:(?:just|only)\s+)?once\b|\b(?:one[- ]off|one[- ]time)\s+(?:check|query|look|inspection)\b|\b(?:do not|don't|no|not|never|stop|cancel)\b[^,.!?;\n]{0,40}\b(?:watch(?:ing)?|monitor(?:ing)?|track(?:ing)?|subscription|follow(?:ing)?(?:[- ]?up)?|notify)\b/i.test(words);
  if (oneShot) return false; // Contradictory wording must be clarified, not guessed.
  return /盯|(?:持续|继续|长期|后续|以后).{0,12}(?:跟进|跟踪|监控|关注|检查)|(?:有变化|有变动|通过后|成功后).{0,8}(?:提醒|通知)|\b(?:watch|monitor|follow|track)\b|\bkeep\s+(?:watching|monitoring|tracking)\b|\bnotify\s+me\s+(?:when|if|on)\b/i.test(words);
}

export function hasExplicitPrCancelIntent(text: string): boolean {
  const words = withoutPrUrls(text);
  const residual = words.replace(/(?:不用|不要|不必|无需|不再|别再)(?:再|继续|持续)?(?:盯|跟进|跟踪|监控)/g, ' ');
  if (/(?:不要|不用|不必|无需|不想|不能|不准|不是|别)|\b(?:not|no|don't|never)\b/i.test(residual)) return false;
  // An id identifies a target, not consent. Retaining, negating, hypothetical and how-to
  // requests fail closed, including mixed instructions which need target-specific clarification.
  if (/(?:不要|不用|无需|不必|不想|不能|别|不)(?:再|现在|立即)?(?:取消|停止|结束|删除)|保留|(?:保持|继续).{0,8}(?:跟进|监控|盯)|(?:如何|怎么|怎样|如果|假如).{0,20}(?:取消|停止)/.test(words)
    || /\b(?:do not|don't|no|not|never)\b[^,.!?;\n]{0,24}\b(?:cancel|stop|end|remove)\b|\b(?:keep|retain)\b|\bcontinue\s+(?:watching|monitoring|tracking|following)\b|\b(?:how|if|whether)\b[^,.!?;\n]{0,32}\b(?:cancel|stop|end|remove)\b/i.test(words)) return false;
  return words.split(/[，。！？；,.!?;\n]/).some(clause => {
    if (/\b(?:worker|turn|process)\b|进程|机器|回合|定时任务/i.test(clause)) return false;
    return /(?:取消|停止|结束|\b(?:cancel|stop|end|remove)\b).{0,40}(?:跟进|监控|盯|\bPR\b|\bwatch\b|\bmonitor\b|\bpw_[\w-]+\b)|(?:不用|不要|不必|无需|不再|别再)(?:再|继续|持续)?(?:盯|跟进|跟踪|监控)/i.test(clause);
  });
}

/** CI alongside commit statuses requests full evidence unless CI/Checks was negated. */
export function mentionsFullPrCi(text: string): boolean {
  const positive = withoutPrUrls(text).replace(/(?:不要|不用|无需|不需要|不看|别)(?:验证|检查|查看|看|查|关注)?\s*(?:完整\s*)?(?:check[ -]?runs?|\bCI\b|\bChecks\b|\bActions\b)|(?:check[ -]?runs?|\bCI\b|\bChecks\b|\bActions\b)\s*(?:不用管|不要管|不检查|不用检查)/gi, ' ');
  const scoped = positive.replace(/\b(?:do not|don't|no|without|not)\s+(?:(?:check|verify|inspect)\s+)?(?:check[ -]?runs?|CI|Checks|Actions)\b/gi, ' ');
  return /check[ -]?runs?|\bchecks\b|\bactions\b|\bCI\b|全部检查/i.test(scoped);
}

/** Explicit authorization to keep a PR watch active past green CI until merge/close (reviews & conflicts). */
export function hasExplicitPrUntilMergeIntent(text: string): boolean {
  const cleaned = withoutPrUrls(text)
    .replace(/(?:不要|不用|无需|不需要|不看|别)(?:跟进|看|查|关注|管)?\s*(?:评审|评论|review|冲突|conflict|合并)/gi, ' ')
    .replace(/\b(?:do not|don't|no|without|not)\s+(?:watch|check|follow|track)?\s*(?:reviews?|comments?|conflicts?|merge)\b/gi, ' ');
  return /(?:直到|直至|一直盯到|盯到|等到).{0,8}(?:合并|合入|关闭)|评审|review\s*(?:意见|评论|comments?|threads?|changes)?|合并冲突|\bconflicts?\b|\buntil\s+(?:merged|merge|closed)\b/i.test(cleaned);
}
