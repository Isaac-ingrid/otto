// Conservative lexical gate, not a general natural-language authorization parser.
// A real owner + PR link authorizes neither persistent work nor overriding a one-shot request.
export const withoutPrUrls = (text: string): string => text.replace(/https?:\/\/[^\s<>"'`，。；！？）)\]]+/gi, ' ');

export function hasExplicitPrWatchIntent(text: string): boolean {
  const words = withoutPrUrls(text);
  const oneShot = /(?:只|仅)(?:看|查|检查|查询|验证)?(?:这)?(?:一次|一遍|一回|这次|本次)|(?:不要|不用|无需|不需要|不想|不是|别|停止|取消)[^，。！？；\n]{0,16}(?:跟进|跟踪|监控|订阅|盯|提醒|通知)|不(?:再|必)?(?:持续|继续|长期|自动)?(?:跟进|跟踪|监控|订阅|盯|提醒|通知)/.test(words)
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
  if (/(?:不要|不用|无需|不必|不想|不能|别|不)(?:再|现在|立即)?(?:取消|停止|结束|删除)|保留|保持.{0,8}(?:跟进|监控|盯)|(?:如何|怎么|怎样|如果|假如).{0,20}(?:取消|停止)/.test(words)
    || /\b(?:do not|don't|no|not|never)\b[^,.!?;\n]{0,24}\b(?:cancel|stop|end|remove)\b|\b(?:keep|retain)\b|\bcontinue\s+(?:watching|monitoring|tracking|following)\b|\b(?:how|if|whether)\b[^,.!?;\n]{0,32}\b(?:cancel|stop|end|remove)\b/i.test(words)) return false;
  return /取消|停止|结束.{0,8}(?:跟进|监控|盯)|(?:不用|不要|不必|无需|不再|别再)(?:再|继续|持续)?(?:盯|跟进|跟踪|监控)|\b(?:cancel|stop|end|remove)\b/i.test(words);
}

/** CI alongside commit statuses requests full evidence unless CI/Checks was negated. */
export function mentionsFullPrCi(text: string): boolean {
  const positive = withoutPrUrls(text).replace(/(?:不要|不用|无需|不需要|不看|别)(?:验证|检查|查看|看|查|关注)?\s*(?:完整\s*)?(?:check[ -]?runs?|\bCI\b|\bChecks\b|\bActions\b)|(?:check[ -]?runs?|\bCI\b|\bChecks\b|\bActions\b)\s*(?:不用管|不要管|不检查|不用检查)/gi, ' ');
  const scoped = positive.replace(/\b(?:do not|don't|no|without|not)\s+(?:(?:check|verify|inspect)\s+)?(?:check[ -]?runs?|CI|Checks|Actions)\b/gi, ' ');
  return /check[ -]?runs?|\bchecks\b|\bactions\b|\bCI\b|全部检查/i.test(scoped);
}
