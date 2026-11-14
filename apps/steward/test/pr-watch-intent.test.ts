import { describe, expect, it } from 'vitest';
import { hasExplicitPrWatchIntent, mentionsFullPrCi } from '../src/pr-watch-intent.ts';

describe('persistent PR authorization boundary', () => {
  it.each([
    '持续盯住 PR 12 的 CI 和 commit statuses，有变化提醒我。',
    '帮我盯住这个 PR，仅看 commit statuses，通过后通知，不要改代码。',
    '继续盯住这个 PR。',
    '这个 PR 后面有变动就提醒我。',
    '以后帮我持续跟进 PR 12。',
    'Follow https://github.com/example/project/pull/42; only commit statuses.',
    'Monitor this PR and notify me once when it passes.',
    'Keep watching this PR, do not change code.',
  ])('accepts persistent intent: %s', text => expect(hasExplicitPrWatchIntent(text)).toBe(true));

  it.each([
    '帮我看下 PR 12 的 CI。',
    '只看 commit statuses。',
    '现在只查这一次，不要创建持续跟进或定时任务。',
    '现在只看一次 PR 12 的 commit statuses，不要持续跟进。',
    '持续盯住 PR，但只查这一次。',
    '不用你一直盯 PR 了。',
    '不需要你持续跟进。',
    '别再帮我盯 PR。',
    '停止监控这个 PR。',
    '不盯这个 PR，只查状态。',
    '不持续跟进这个 PR。',
    '不是让你持续盯这个 PR。',
    'This is not a request to monitor this PR.',
    'Check this PR only once.',
    'One-off check of this PR, no monitoring.',
    "Don't create a persistent watch for this PR.",
    "Don't keep watching this PR.",
    'Stop monitoring this PR.',
    'I do not want you to monitor this PR.',
    'https://github.com/watch/monitor/pull/42 帮我看下状态。',
  ])('refuses absent, negated or contradictory intent: %s', text => expect(hasExplicitPrWatchIntent(text)).toBe(false));
});

describe('full CI scope recognition', () => {
  it.each(['持续盯住 CI 和 commit statuses。', '完整 CI', 'check runs and commit statuses', 'GitHub Actions', '全部检查'])('recognizes positive scope: %s', text => expect(mentionsFullPrCi(text)).toBe(true));
  it.each(['仅看 commit statuses，Checks 不用管。', '持续盯 commit statuses，CI 不用管。', '持续盯 commit statuses，不需要检查 CI。', "monitor commit statuses, don't check CI", "monitor commit statuses, don't check runs", '持续盯 commit statuses，不要查看 Checks', 'monitor commit statuses, no Checks', 'https://github.com/CI/Checks/pull/42 commit statuses'])('does not infer full scope from negation or URL: %s', text => expect(mentionsFullPrCi(text)).toBe(false));
});
