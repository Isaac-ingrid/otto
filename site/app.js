// Self-contained interactive controller for Otto's static showcase site.
// Zero dependencies, zero HTML sinks (pure DOM nodes & textContent), full keyboard roving tabs.

const REPO_BASE = ['https://github.com', 'Isaac-ingrid', 'otto'].join('/');
const NPM_PKG = '@isaac2ingrid/otto';

const COPY = {
  pageTitle: [
    'Otto · Coordinate local coding agents from one workspace',
    'Otto · 在一个网页里调度你几台电脑上的 coding agent',
  ],
  navPreview: ['Examples', '界面示例'],
  navArch: ['Architecture', '系统结构'],
  navBoundaries: ['Design notes', '设计取舍'],
  navQuickstart: ['Setup', '安装运行'],
  navDocs: ['Docs', '文档'],
  heroEyebrow: ['Open Source · Self-Hosted', '开源 · 自托管'],
  heroTitle: [
    'Coordinate the coding agents on your computers from one web workspace.',
    '在一个网页里，调度你几台电脑上的 coding agent。',
  ],
  heroLead: [
    'When working across a laptop, a desktop, and a phone, it is hard to track what each local agent is doing. Otto runs a persistent Steward process on your server to hold conversations, task state, quota-cooldown recovery, and reminders, while dispatching code work to pi, Claude Code, Codex CLI, or OpenCode on your own computers. Repositories and full session logs remain on local disk.',
    '在笔记本、台式机和手机之间切换工作时，往往很难集中追踪各台机器上的任务进度。Otto 在你自己的服务器上运行一个常驻进程（Steward），统一维护对话、事项状态、限流冷却恢复与待办提醒；涉及读写代码的任务则分发给各台电脑上的 pi、Claude Code、Codex CLI 或 OpenCode 执行，代码仓库与完整会话日志始终留在本地。',
  ],
  heroCtaStart: ['Setup guide', '安装与运行'],
  heroCtaPreview: ['See workflows', '查看典型场景'],
  copyBtn: ['Copy', '复制'],
  copiedBtn: ['Copied', '已复制'],
  factAgents: [
    'Local adapters: pi · Claude Code · Codex CLI · OpenCode / Agentica (ACP) · dsh / zcode',
    '本地适配器：pi · Claude Code · Codex CLI · OpenCode / Agentica（ACP）· dsh / zcode',
  ],
  factOS: [
    'Connectors: macOS · Linux · Windows (outbound WS, local SHA-256 probes & OS desktop notifications)',
    '连接器运行环境：macOS · Linux · Windows（出站连接，免开入站端口，含桌面通知与本地探针）',
  ],
  factHost: [
    'Steward host: Linux VPS (Node.js + SQLite) or Cloudflare Workers',
    '服务端运行环境：Linux VPS（Node.js + SQLite）或 Cloudflare Workers',
  ],
  previewKicker: ['WORKFLOWS', '界面示例'],
  previewTitle: [
    'Five everyday workflows',
    '日常使用的五个典型场景',
  ],
  previewSub: [
    'Select a tab below (or press Left / Right arrow keys) to switch between workflows.',
    '点击下方标签（或按键盘 ← / → 方向键）切换不同工作流。',
  ],
  scTabDispatch: ['Run a local task', '派发本地任务'],
  scTabPr: ['PR watch & blind review', 'PR 跟进与盲审'],
  scTabAutoloop: ['Quota hold & probes', '限流挂起与探针'],
  scTabMemory: ['Notes & repo skills', '项目记忆与技能'],
  scTabAudit: ['Spend & worktrees', '费用与目录清理'],
  mockThreadsLabel: ['Threads', '事项列表'],
  mockMachinesLabel: ['Connected Machines', '已连接的电脑'],
  mockContextLabel: ['Current State', '当前状态'],
  archKicker: ['ARCHITECTURE', '系统结构'],
  archTitle: [
    'Architecture and responsibilities',
    '整体架构与职责划分',
  ],
  archSub: [
    'The server persists state in a single SQLite file and verifies inbound webhooks; your computers connect via outbound WebSockets with no public IP or port forwarding.',
    '服务端使用单个 SQLite 文件持久化状态并接收验签 Webhook；本地电脑通过出站 WebSocket 连接服务端，无需公网 IP 或端口映射。',
  ],
  svgT1Title: ['Browsers & Channels', '浏览器与外部通知'],
  svgT1B1: ['• Chat history + decision cards', '• 对话记录与待处理卡片'],
  svgT1B2: ['• Cmd/Ctrl+K hybrid search', '• Cmd/Ctrl+K 全文混合检索'],
  svgT1B3: ['• Passkey, Push & Feishu cards', '• Passkey、Push 与飞书签名卡'],
  svgLink1: ['Live sync', '实时同步'],
  svgT2Title: ['Linux VPS (or Workers)', '云服务器（或 Workers）'],
  svgT2B1: ['Code paths: cooldown / probe / PR', '确定逻辑：冷却 / 探针 / PR 分诊'],
  svgT2B2: ['Model calls: routing (8-hop cap)', '模型调用：路由 / 摘要（8 跳熔断）'],
  svgT2B3: ['SQLite + FTS5 + Webhooks', '单文件 SQLite + FTS5 + Webhook'],
  svgLink2Top: ['Outbound WS', '出站连接'],
  svgLink2Bot: ['No inbound port', '免开入站端口'],
  svgT3B1: ['• pi / Claude / Codex / ACP', '• pi / Claude / Codex / ACP 等'],
  svgT3B2: ['• Worktrees, PR diff & probes', '• Worktree、零检出 Diff 与探针'],
  svgT3B3: ['• Local repos + desktop notify', '• 仓库留本机磁盘 + 系统桌面通知'],
  pillarATag: ['Offline-Tolerant', '离线可用'],
  pillarATitle: ['Queue tasks and notes while local machines sleep', '本地设备休眠时仍可记录与排期'],
  pillarABody: [
    'While your laptop is asleep, the web workspace stays available for chatting, recording notes, and reviewing history or PR status. Tasks that touch code wait in the queue until the target machine reconnects.',
    '笔记本休眠期间，网页端依然可以发起对话、记录备忘、查看历史事项与 PR 状态。需要读写代码的任务会先进入队列，待目标机器重连后自动下发。',
  ],
  pillarBTag: ['Networking & Keys', '网络与密钥'],
  pillarBTitle: ['Outbound-only connections, separate model keys', '纯出站连接，模型密钥各自独立'],
  pillarBBody: [
    'Home and office computers only need outbound HTTPS access to your server, with no inbound ports. The Steward process and local coding agents read separate model configs — local keys are never uploaded.',
    '家庭或办公电脑只需能访问服务器的 HTTPS 地址即可接入，无需开通入站端口。服务端进程与本地 coding agent 各自读取独立的模型配置，本地密钥不会上传至服务端。',
  ],
  pillarCTag: ['Deployment', '部署方式'],
  pillarCTitle: ['Runs on a standard Linux VPS', '常规 Linux VPS 即可独立运行'],
  pillarCBody: [
    'It compiles into a single Node.js bundle backed by SQLite under systemd. If you prefer not to maintain a VM, the same codebase also runs on Cloudflare Workers.',
    '服务端编译产物为单个 Node.js 文件配合 SQLite 数据库，通过 systemd 即可托管；如不想维护服务器，同一套代码也支持运行在 Cloudflare Workers 上。',
  ],
  boundKicker: ['DESIGN NOTES', '设计取舍'],
  boundTitle: [
    'Key engineering trade-offs',
    '关键工程取舍',
  ],
  boundSub: [
    'Concrete implementation rules aimed at preventing lost context, quota failures, runaway loops, and accidental side effects during long tasks.',
    '针对长周期任务中常见的上下文遗忘、配额限流、死循环与误操作问题，系统在实现上做了以下约束。',
  ],
  bound1Tag: ['State Storage', '状态存储'],
  bound1Title: ['Task progress and project notes stored in SQLite', '事项进度与项目备注独立存入 SQLite'],
  bound1Body: [
    'Thread status, worker reports, and project conventions live in structured tables, and each turn receives a concise snapshot. Compaction on long chats never drops earlier agreements.',
    '事项状态、worker 汇报和项目约定都保存在结构化表里，每轮对话仅向模型注入当前状态摘要，避免长对话压缩历史记录时丢失早期约定。',
  ],
  bound2Tag: ['Less Model Reliance', '减少模型依赖'],
  bound2Title: ['Routine workflows and local probes run directly in code', '固定流程与本地探针直接走常规代码'],
  bound2Body: [
    'Timeout checks, PR polling, and SHA-256-approved local scripts under ~/.otto/probes/ run in deterministic code (consuming 0 tokens when untriggered). Clean runs missing a report execute at most one read-only salvage pass.',
    '超时检测、PR 轮询与 ~/.otto/probes/ 下经 SHA-256 审批的本地巡检脚本均由确定性代码驱动（未触发时消耗 0 Token）；worker 漏调 report 时也仅做最多一次只读补报。',
  ],
  bound3Tag: ['Explicit Approval', '权限确认'],
  bound3Title: ['Side-effecting actions require clicking a confirmation card', '涉及外部变更的操作必须点击确认卡'],
  bound3Body: [
    'Starting or cancelling a PR watch, dispatching a cross-machine probe, removing an unmerged worktree, or writing a SKILL.md file requires clicking its dedicated card button. Repo isolation and probe approvals can only be changed locally via CLI.',
    '开启或取消 PR 跟进、派发跨机只读探针、清理含未合并提交的 worktree、写入仓库技能文件，均需点击专用确认按钮；仓库隔离与本地探针白名单仅允许在本机 CLI 修改。',
  ],
  bound4Tag: ['Stop & Loop Guards', '中断与熔断'],
  bound4Title: ['Three-way independent stop and 8-hop loop circuit breaker', '三路独立停止，8 跳自动推进熔断'],
  bound4Body: [
    'Stopping the current reply, interrupting a local coding agent, and cancelling a PR watch are separate controls; autonomous event/follow-up chains automatically pause above 8 consecutive hops (autoHops) until you reply.',
    '终止当前回复、中断本地运行中的 agent、取消后台 PR 跟进互不牵连；事件与定时回看构成的连续自动执行链超过 8 跳（autoHops）会强制暂停，防止无人值守死循环。',
  ],
  bound5Tag: ['Quota Cooldowns', '限流恢复'],
  bound5Title: ['Dual-granularity quota hold with automatic resume', '双粒度限流冷却挂起，到期自动续跑'],
  bound5Body: [
    'Distinguishes quota/rate-limit windows from auth or billing errors: throttled sessions park in idle per (machine, provider/agent) with their worktree intact, release serial repo slots, and auto-resume when the window resets without an LLM call.',
    '区分鉴权欠费与窗口配额限流：触发限流时按 (机器, provider/agent) 登记重置时刻并将会话挂起为 idle（保留 worktree 与原会话、释放串行槽位），窗口恢复后无需调用大模型即可自动接续。',
  ],
  bound6Tag: ['Blind Review & Alerts', '零检出盲审与通知'],
  bound6Title: ['Zero-checkout git-object PR review and signed notifications', '裸 Git 对象盲审，多端通知不泄密'],
  bound6Body: [
    'PR blind review extracts diffs directly from git objects (hooks disabled, octopus merges refused, dirty local worktrees untouched) and runs an author-isolated cross-engine read-only pass; supports OS desktop alerts and SSRF-guarded Feishu V2 / DingTalk / WeCom / Slack webhooks.',
    'PR 盲审直接从裸 Git 对象提取差异（禁用 hooks、拒绝章鱼合并、不触碰本地脏工作区），剥离原作者推理后交由异构只读引擎审查；支持本机桌面通知与 SSRF 防护下的飞书 V2 / 企微 / 钉钉签名推送。',
  ],
  qsKicker: ['SETUP', '上手步骤'],
  qsTitle: [
    'Install and run',
    '安装与运行',
  ],
  qsSub: [
    'Start a temporary local stack to evaluate the full workflow first, then deploy the Steward to a VPS for 24/7 operation.',
    '可以先在本地启动临时环境体验完整流程，确认符合需求后再部署到云服务器长期运行。',
  ],
  qsTabLocal: ['Local trial', '本地快速体验'],
  qsTabVps: ['Deploy to VPS', '部署至云服务器'],
  qsTabConnect: ['Connect machines', '接入工作电脑'],
  docsKicker: ['DOCS', '文档'],
  docsTitle: ['Documentation', '说明文档'],
  docsSub: [
    'Reverse proxy setup, troubleshooting steps, API formats, and known limitations are documented under docs/.',
    '具体的反向代理配置、常见故障排查、API 格式与已知边界说明均整理在仓库的 docs/ 目录中。',
  ],
  footerCopy: [
    'Otto · MIT License',
    'Otto · MIT License',
  ],
};

const SCENARIOS = {
  dispatch: {
    stats: { machines: '2/3', running: '1', waiting: '1', spend: '$0.14' },
    activeThread: 0,
    threads: [
      { title: ['Debug concurrent state refresh', '排查并发状态刷新失败'], meta: 'pi · mac-studio · running' },
      { title: ['PR #42 watch & blind review', '跟进 PR #42 与盲审'], meta: 'watch · github' },
      { title: ['Sync market cache worker', '重构行情缓存同步逻辑'], meta: 'pi · cooldown -> 14:00' },
    ],
    paneTitle: ['Debug concurrent state refresh', '排查并发状态刷新失败'],
    paneSub: 'Thread · otto/fix-state-race',
    userMsg: [
      'Run pi on mac-studio to check why state refresh occasionally drops. Use an isolated worktree so my active branch stays untouched.',
      '在 mac-studio 上用 pi 排查偶发状态刷新失效的问题，拉独立 worktree 运行，保留我当前分支上的未提交改动。',
    ],
    agentMeta: ['OTTO · JUST NOW', 'OTTO · 刚刚'],
    agentMsg: [
      'Checked out otto/fix-state-race in an isolated worktree on mac-studio and started pi. Two parallel requests were overwriting state; adding a mutex and regression test.',
      '已在 mac-studio 检出独立目录 otto/fix-state-race 并启动 pi。定位到并发刷新请求存在状态覆盖，正在补充互斥锁与回归测试。',
    ],
    cardTone: 'warn',
    cardKind: ['QUESTION FROM WORKER', '待确认方案'],
    cardTitle: [
      'Serialize concurrent refreshes in memory, or keep a 10-second grace window?',
      '并发刷新改为进程内串行排队，还是保留 10 秒旧状态兼容窗口？',
    ],
    cardBody: [
      'pi reproduced the issue locally and is waiting for your decision before committing.',
      'pi 已在本地复现该问题，确认方案后将继续完成修改并提交。',
    ],
    actions: [
      ['Serialize in memory', '进程内串行排队'],
      ['10s grace window', '保留 10 秒兼容窗口'],
    ],
    facts: [
      {
        title: 'mac-studio · pi (deepseek-flash)',
        body: [
          'Edits happen inside an isolated Git worktree; uncommitted changes in your main checkout remain untouched.',
          '文件修改均在独立 Git worktree 内进行，主工作区未提交的改动不受影响。',
        ],
        meter: 18,
        sub: ['Context: 182k / 1M tokens (18%)', '上下文用量：182k / 1M tokens（18%）'],
      },
      {
        title: ['Session log & report salvage', '原始会话与补报兜底'],
        body: [
          'Inspect raw terminal output and diffs live; if an agent finishes cleanly without calling report, Otto runs at most one read-only salvage pass.',
          '可随时查看该机器上的原始会话与 diff；若 agent 正常结束但漏调 report，连接器最多执行一次只读补报回收结论。',
        ],
      },
    ],
    caption: [
      'Dispatch tasks from your phone or another laptop; the connector checks out an isolated Git worktree so your active branch stays clean.',
      '从手机或另一台电脑下发任务时，连接器会按仓库策略检出独立 Git worktree，不干扰本地正在开发的分支。',
    ],
  },
  pr: {
    stats: { machines: '2/3', running: '1', waiting: '1', spend: '$0.11' },
    activeThread: 1,
    threads: [
      { title: ['Debug concurrent state refresh', '排查并发状态刷新失败'], meta: 'pi · mac-studio · idle' },
      { title: ['PR #42 watch & blind review', '跟进 PR #42 与盲审'], meta: 'codex · blind review' },
      { title: ['Clean old worktree folders', '清理历史分支目录'], meta: 'audit · 2 machines' },
    ],
    paneTitle: ['Follow PR #42 & Zero-Checkout Blind Review', '跟进 PR #42 与零检出交叉盲审'],
    paneSub: 'PR Watch · pull/42 · claude-code -> codex',
    userMsg: [
      'Follow PR #42 on this thread. Run a zero-checkout blind review on the latest commit without touching my local dirty checkout.',
      '在此事项下跟进 PR #42，并对最新提交跑一次零检出盲审，不要切换或改动我本地带未提交修改的工作区。',
    ],
    agentMeta: ['BLIND REVIEW · CODEX READONLY', '零检出盲审 · CODEX 只读会话'],
    agentMsg: [
      'Extracted unified diff from bare git objects (core.hooksPath=/dev/null, 6 files, dirty worktree untouched) and ran codex in an author-isolated read-only session.',
      '已直接从裸 Git 对象提取 PR #42 差异（禁用 hooks，共 6 个文件，未触碰本地脏工作区），剥离原作者上下文后由异构引擎 codex 完成只读审查。',
    ],
    cardTone: 'warn',
    cardKind: ['PR STUCK / REVIEW ACTION', 'PR 诊断与处理确认'],
    cardTitle: [
      '1 race condition found in session refresh; dispatch a worker to fix or keep watching?',
      '盲审发现会话刷新存在 1 处并发竞态；是否派发 worker 修复或继续只读跟进？',
    ],
    cardBody: [
      'Author reasoning was stripped before review; octopus merges (parentCount > 2) are refused automatically.',
      '审查提示词已剥离原作者对话说明以防思维定势；遇到多父节点章鱼合并时会自动拒绝失真对比。',
    ],
    actions: [
      ['Dispatch fix worker', '派发 worker 修复'],
      ['Keep watching only', '继续只读跟进'],
    ],
    facts: [
      {
        title: ['Zero-checkout git_pr_diff', '零检出裸对象提取'],
        body: [
          'Fetches PR refs and computes three-dot diffs without git checkout, merge, or hooks — local uncommitted edits stay intact.',
          '直接拉取远端引用计算三点差异，不执行 checkout、merge 或仓库钩子，本地未提交代码毫发无损。',
        ],
      },
      {
        title: ['Stalled-head alert (>2h)', '2 小时停滞去重提醒'],
        body: [
          'If checks, conflicts, or requested changes stall past 2 hours, Otto sends one consent card per head and never auto-merges.',
          '同一提交卡在等待检查、冲突或待修改状态超过 2 小时时推送单次确认卡，绝不自动合并或改写远端 PR。',
        ],
      },
    ],
    caption: [
      'Monitor CI, conflicts, and stalled heads without a running worker, and trigger cross-engine blind reviews without touching local branches.',
      '无需挂着本地 agent 即可持续监测 CI、冲突与停滞状态，并支持在不污染本地分支的前提下执行跨引擎零检出盲审。',
    ],
  },
  autoloop: {
    stats: { machines: '2/3', running: '0', waiting: '1', spend: '$0.12' },
    activeThread: 0,
    threads: [
      { title: ['Sync market cache worker', '重构行情缓存同步逻辑'], meta: 'pi:zai-coding-cn · hold' },
      { title: ['Probe: dist bundle check', '本地探针：产物完整性巡检'], meta: 'probe · sha256 · 0 tok' },
      { title: ['GitHub webhook: main CI', '入站事件：main 构建通知'], meta: 'verified · autoHops 2/8' },
    ],
    paneTitle: ['Quota Cooldown Hold & Zero-Token Probes', '额度冷却挂起与零 Token 本地探针'],
    paneSub: 'Cooldown · pi:zai-coding-cn -> resets 14:00',
    userMsg: [
      'Continue refactoring the cache sync module on thinkpad-linux and run the hourly local build probe.',
      '继续在 thinkpad-linux 上完成缓存同步模块重构，并保持每小时一次的本地构建产物探针巡检。',
    ],
    agentMeta: ['QUOTA HOLD · AUTO-RESUME ARMED', '额度冷却挂起 · 已排期自动续跑'],
    agentMsg: [
      'zai-coding-cn hit its 5-hour quota window. Worker w_01m89 parked in idle (worktree & session preserved, serial repo slot released) and will auto-resume at 14:00.',
      'zai-coding-cn 触发套餐窗口限流。会话 w_01m89 已挂起为 idle（独立 worktree 与原会话完整保留，仓库串行写槽位已释放），将于 14:00 窗口重置后自动续跑。',
    ],
    cardTone: 'warn',
    cardKind: ['QUOTA COOLDOWN · THINKPAD-LINUX', '额度窗口冷却挂起'],
    cardTitle: [
      'Wait for 14:00 zero-LLM auto-resume, or switch to codex / deepseek on thinkpad-linux now?',
      '等待 14:00 到期零开销自动续跑，还是立即切到同机未限流的 codex / deepseek 继续？',
    ],
    cardBody: [
      'Feishu Schema 2.0 card (with single-use 7-day sign-in link) and local OS desktop notification delivered.',
      '已同步推送本机系统桌面通知与飞书 Schema 2.0 签名卡片（附 7 天有效单次免密跳转链接，二次点击返回 HTTP 410 防重放）。',
    ],
    actions: [
      ['Switch to codex now', '切到同机 codex 继续'],
      ['Wait until 14:00', '等待 14:00 自动恢复'],
    ],
    facts: [
      {
        title: ['Dual-granularity cooldowns', '双粒度冷却与自动续跑'],
        body: [
          'Tracks pi:<provider> separately from agent:<kind>; rate limits never mark a healthy session broken.',
          '按 pi:<provider> 与 agent:<kind> 分离记录冷却窗口，不把临时限流误判为鉴权损坏，到期由定时器直接唤醒原会话。',
        ],
      },
      {
        title: ['SHA-256 probes & 8-hop cap', '零 Token 探针与 8 跳熔断'],
        body: [
          'Scripts approved via otto probe approve consume 0 LLM tokens while triggered: false; autonomous chains pause past 8 hops.',
          '经 otto probe approve 签名的本地脚本未触发时消耗 0 Token；外部事件与回看连续自动执行超过 8 跳即触发熔断。',
        ],
      },
    ],
    caption: [
      'Temporary rate limits park the worker cleanly until reset instead of failing the task, while SHA-256 local probes keep routine checks at zero token cost.',
      '遇到临时限流时自动保留现场并在窗口恢复后接续执行，配合本地 SHA-256 脚本探针实现零 Token 日常巡检。',
    ],
  },
  memory: {
    stats: { machines: '2/3', running: '0', waiting: '1', spend: '$0.18' },
    activeThread: 0,
    threads: [
      { title: ['Control Plane · Memory & Skills', '控制面板 · 记忆与技能'], meta: 'notes + repo skills' },
      { title: ['Debug concurrent state refresh', '排查并发状态刷新失败'], meta: 'pi · mac-studio · done' },
      { title: ['PR #42 watch & blind review', '跟进 PR #42 与盲审'], meta: 'watch · green' },
    ],
    paneTitle: ['Project Notes & Repo Skills', '项目记忆与仓库技能'],
    paneSub: 'Control Plane · Memory & Skills',
    userMsg: [
      'Record that frontend modules in this repo use plain DOM builders and disallow digits in i18n keys.',
      '记录本仓库前端约定：UI 模块统一使用纯 DOM 构造器，且 i18n 键名不得包含数字。',
    ],
    agentMeta: ['SAVED NOTE + SKILL DRAFT', '已存记忆 · 附技能草稿'],
    agentMsg: [
      'Saved as an owner-confirmed note for otto. Since recent UI tasks hit the same test gate, prepared a SKILL.md draft for review.',
      '已写入当前项目的常驻记忆（来源标记为本人确认）。鉴于近期多次界面修改均涉及同一测试门禁，已同步生成 SKILL.md 草稿供审阅。',
    ],
    cardTone: 'ok',
    cardKind: ['SKILL DRAFT', '技能文件草稿'],
    cardTitle: [
      'Write .agents/skills/steward-ui-gates/SKILL.md to mac-studio?',
      '是否将 .agents/skills/steward-ui-gates/SKILL.md 写入 mac-studio 仓库？',
    ],
    cardBody: [
      'You can edit the draft in the modal before saving, or write it only into the test worktree first.',
      '可在弹窗内编辑内容后再保存，也可仅写入当前测试 worktree 验证效果。',
    ],
    actions: [
      ['Review & save', '审阅并保存'],
      ['Keep note only', '仅保留记忆项'],
    ],
    facts: [
      {
        title: ['Provenance labels', '记录来源标记'],
        body: [
          'Each note records whether it came from you, a worker report, or inference, making outdated assumptions easy to audit.',
          '每条记录均区分本人确认、worker 汇报与上下文推断三种来源，便于后续核对与修订。',
        ],
      },
      {
        title: ['Explicit file writes', '显式确认落盘'],
        body: [
          'Creating or updating a repository SKILL.md always presents a diff/draft for confirmation before writing to disk.',
          '新增或更新仓库内的 SKILL.md 均需先审阅草稿并手动确认，不会在后台静默写入文件。',
        ],
      },
    ],
    caption: [
      'Store project conventions independently of chat history, and turn recurring troubleshooting steps into repository SKILL.md files.',
      '将项目长期约定独立于聊天上下文保存，并支持将高频排错经验沉淀为仓库内的 SKILL.md 文件。',
    ],
  },
  audit: {
    stats: { machines: '2/3', running: '1', waiting: '0', spend: '$0.21' },
    activeThread: 2,
    threads: [
      { title: ['Debug concurrent state refresh', '排查并发状态刷新失败'], meta: 'pi · mac-studio · done' },
      { title: ['PR #42 watch & blind review', '跟进 PR #42 与盲审'], meta: 'watch · green' },
      { title: ['Control Plane · Worktree Audit', '控制面板 · 目录清理'], meta: '4 merged · 1.8 GB' },
    ],
    paneTitle: ['Spend & Git Worktree Cleanup', '用量统计与 Worktree 清理'],
    paneSub: 'Control Plane · Telemetry & Worktrees',
    userMsg: [
      'Check disk usage of managed worktrees on mac-studio and clean up branches that are already merged.',
      '查看 mac-studio 上托管 worktree 的磁盘占用情况，并清理已合并的旧分支目录。',
    ],
    agentMeta: ['WORKTREE SCAN · MAC-STUDIO', '目录扫描结果 · MAC-STUDIO'],
    agentMsg: [
      'Scanned 7 Otto worktrees on mac-studio: 4 are merged and clean (1.84 GB total). 1 older branch has unmerged commits and remains unchecked.',
      '在 mac-studio 上扫描到 7 个托管 worktree：其中 4 个已合并且工作区干净（共 1.84 GB）；另有 1 个旧分支含未合并提交，默认未勾选。',
    ],
    cardTone: 'ok',
    cardKind: ['CLEANUP READY', '可安全清理'],
    cardTitle: [
      'Remove 4 merged worktrees (1.84 GB) and run git worktree prune',
      '清理 4 个已合并目录（共 1.84 GB）并执行 git worktree prune',
    ],
    cardBody: [
      'Active workers and manually created worktrees are excluded; removing unmerged branches requires a separate confirmation.',
      '运行中的任务目录与非 Otto 创建的 worktree 已自动排除；删除未合并分支需单独二次确认。',
    ],
    actions: [
      ['Remove 4 clean dirs', '清理已合并目录'],
      ['Inspect unmerged branch', '查看未合并分支'],
    ],
    facts: [
      {
        title: ['Spend & context metrics', '费用与上下文监控'],
        body: [
          'Displays 7/14/30-day Steward API spend in USD alongside each local worker context window utilization.',
          '分别展示服务端近 7/14/30 天的 API 美元开销与各台机器本地会话的上下文占用比例。',
        ],
        meter: 21,
        sub: ['Today: $0.21 / $1.00 budget', '今日服务端开销：$0.21 / $1.00'],
      },
      {
        title: ['Pre-delete branch verification', '删除前二次校验'],
        body: [
          'The connector re-verifies the current branch and clean status right before removing each directory.',
          '连接器在执行删除前会再次校验目录分支名与未提交改动状态，防止误删新产生的提交。',
        ],
      },
    ],
    caption: [
      'Isolated worktrees accumulate on disk over time; the audit panel lets you inspect and prune merged directories across machines.',
      '长期使用独立 worktree 隔离任务后容易积累旧目录，可在控制面板集中扫描并安全清理已合并目录。',
    ],
  },
};

const QUICKSTARTS = {
  local: {
    label: 'Local dev stack',
    desc: [
      'From a git checkout, one command builds and starts a local Steward (127.0.0.1:8787) and a test connector in a temp directory, then prints a sign-in link:',
      '拉下代码后执行一条命令，即可在临时目录启动本地服务端（127.0.0.1:8787）与测试连接器，并在终端输出登录链接：',
    ],
    lines: [
      `git clone ${REPO_BASE}.git`,
      'cd otto',
      'corepack pnpm install --frozen-lockfile',
      'pnpm local:up',
    ],
  },
  vps: {
    label: 'Linux VPS bundle & smoke check',
    desc: [
      'Build the single-file Node.js bundle on your dev machine, copy dist/node/steward-node.mjs and dist/ui/ to your Linux server behind an HTTPS reverse proxy, and verify health:',
      '在开发机编译单文件产物，将 dist/node/steward-node.mjs 与 dist/ui/ 部署至 Linux 服务器，后续支持一键备份升级与零密钥生产体检：',
    ],
    lines: [
      'corepack pnpm install --frozen-lockfile',
      'corepack pnpm --filter @isaac2ingrid/steward build:node',
      'mkdir -p apps/steward/dist/ui',
      'cp -R apps/steward/ui/. apps/steward/dist/ui/',
      '',
      '# Subsequent upgrades & read-only smoke verification (with deploy/aliyun.env):',
      'pnpm deploy:vps',
      'pnpm verify:prod',
    ],
  },
  connect: {
    label: 'macOS / Linux / Windows connector',
    desc: [
      'Install the CLI on any computer with Node.js 22.18+ and a local coding agent, then run the single-use pairing command generated in Workspace -> Machines:',
      '在已安装 Node.js 22.18+ 与本地 coding agent 的电脑上安装 CLI，随后在工作台的「机器 → 生成配对命令」复制一次性配对命令执行：',
    ],
    lines: [
      `npm i -g ${NPM_PKG}`,
      'otto --version',
      '',
      '# Run the single-use command generated in Workspace -> Machines:',
      'otto connect <your-otto-url> <pairing-code>',
      'otto doctor',
      'otto notify on   # optional: enable native OS desktop notifications',
    ],
  },
};

const DOCS_ITEMS = [
  {
    path: 'docs/self-hosted.md',
    title: ['Self-Hosted Server Guide', '服务器部署手册'],
    desc: [
      'systemd unit setup, HTTPS reverse proxy with WebSocket support, online SQLite backups, deploy:vps / verify:prod, and Web Push.',
      'systemd 配置、HTTPS 与 WebSocket 反向代理、SQLite 在线备份、一键升级体检与 Web Push 配置。',
    ],
  },
  {
    path: 'docs/agent-connect.md',
    title: ['Connector Setup & Local Controls', '连接器安装与本地控制'],
    desc: [
      'Service setup across macOS/Linux/Windows, multi-agent detection, repo write policies, SHA-256 probes (otto probe), and desktop alerts.',
      'macOS、Linux、Windows 后台自启、多引擎检测、仓库隔离策略、本地 SHA-256 探针与系统桌面通知说明。',
    ],
  },
  {
    path: 'docs/usage.md',
    title: ['Daily Usage, Webhooks & API', '使用说明与接口'],
    desc: [
      'Task routing, quota cooldown auto-resume, inbound GitHub/GitLab webhooks, signed Feishu/DingTalk/WeCom/Slack webhooks, and Owner API.',
      '日常派工、限流挂起恢复、GitHub/GitLab 验签入站、飞书 V2 等签名出站 Webhook 以及 Owner API 格式。',
    ],
  },
  {
    path: 'docs/pr-watches.md',
    title: ['PR Watches & Blind Review', 'PR 跟进与零检出盲审'],
    desc: [
      'Confirmation cards, CI failure & conflict triage, 2-hour stuck alerts, and zero-checkout cross-engine blind PR review.',
      '确认卡机制、CI 失败与冲突分诊、2 小时停滞提醒，以及不污染本地脏工作区的跨引擎零检出盲审。',
    ],
  },
  {
    path: 'docs/plan/agent-autoloop-adoptions.md',
    title: ['Autoloop Stages 1–5 Design', '阶段 1–5 可靠性与生态方案'],
    desc: [
      'Dual-granularity quota holds, report salvage, ACP/Command adapters, zero-token probes, 8-hop circuit breaker, and channel security.',
      '双粒度限流冷却、单次补报抢救、ACP/Command 适配器、零 Token 探针、8 跳熔断与多通道安全边界记录。',
    ],
  },
  {
    path: 'docs/design/steward.md',
    title: ['Steward Architecture & Spec', 'Steward 架构设计'],
    desc: [
      'Why state lives in SQLite, how deterministic code and LLM turns divide work, serial turns, and crash recovery.',
      '数据库账本表结构、确定性代码与大模型轮次的分工边界、串行可中止轮次以及崩溃重启恢复机制。',
    ],
  },
];

const SCENARIO_ORDER = ['dispatch', 'pr', 'autoloop', 'memory', 'audit'];
const QS_ORDER = ['local', 'vps', 'connect'];

function detectInitialLang() {
  try {
    const saved = localStorage.getItem('otto.site.lang');
    if (saved === 'zh' || saved === 'en') return saved;
  } catch { /* ignore */ }
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let currentLang = detectInitialLang();
let currentScenario = 'dispatch';
let currentQs = 'local';

const pick = (pair) => (Array.isArray(pair) ? pair[currentLang === 'zh' ? 1 : 0] : pair);

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sp, sv] of Object.entries(v)) node.style.setProperty(sp, sv);
    } else node.setAttribute(k, String(v));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return node;
}

function nextRoving(list, active, key) {
  const idx = Math.max(0, list.indexOf(active));
  if (key === 'ArrowRight') return list[(idx + 1) % list.length];
  if (key === 'ArrowLeft') return list[(idx - 1 + list.length) % list.length];
  if (key === 'Home') return list[0];
  if (key === 'End') return list[list.length - 1];
  return null;
}

function announce(message) {
  const live = document.getElementById('live-announcer');
  if (!live) return;
  live.textContent = '';
  requestAnimationFrame(() => {
    live.textContent = message;
  });
}

function hydrateLinks() {
  const topLink = document.getElementById('repo-top-link');
  if (topLink) {
    topLink.href = REPO_BASE;
    topLink.target = '_blank';
  }
  const heroCmd = document.getElementById('hero-cmd');
  if (heroCmd) heroCmd.textContent = `npm i -g ${NPM_PKG}`;

  const footerLinks = document.getElementById('footer-links');
  footerLinks?.replaceChildren(
    el('a', { href: REPO_BASE, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub'),
    el('a', { href: `${REPO_BASE}/blob/main/README.zh-CN.md`, target: '_blank', rel: 'noopener noreferrer' }, '中文 README'),
    el('a', { href: `${REPO_BASE}/blob/main/README.md`, target: '_blank', rel: 'noopener noreferrer' }, 'English README'),
    el('a', { href: `${REPO_BASE}/blob/main/LICENSE`, target: '_blank', rel: 'noopener noreferrer' }, 'MIT License'),
  );
}

function renderDocs() {
  const grid = document.getElementById('docs-grid');
  if (!grid) return;
  grid.replaceChildren(
    ...DOCS_ITEMS.map((doc) =>
      el(
        'a',
        {
          class: 'doc-card',
          href: `${REPO_BASE}/blob/main/${doc.path}`,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        el(
          'div',
          null,
          el('h3', null, el('span', null, pick(doc.title)), el('span', null, '↗')),
          el('p', null, pick(doc.desc)),
        ),
        el('span', { class: 'doc-path' }, doc.path),
      )),
  );
}

function renderScenario() {
  const data = SCENARIOS[currentScenario];
  if (!data) return;

  for (const id of SCENARIO_ORDER) {
    const btn = document.getElementById(`sc-tab-${id}`);
    if (!btn) continue;
    const active = id === currentScenario;
    btn.setAttribute('aria-selected', String(active));
    btn.setAttribute('tabindex', active ? '0' : '-1');
  }

  document.getElementById('sc-panel')?.setAttribute('aria-labelledby', `sc-tab-${currentScenario}`);
  document.getElementById('mock-machines-stat').textContent = data.stats.machines;
  document.getElementById('mock-running-stat').textContent = data.stats.running;
  document.getElementById('mock-waiting-stat').textContent = data.stats.waiting;
  document.getElementById('mock-spend-stat').textContent = data.stats.spend;

  const threadsWrap = document.getElementById('mock-threads');
  threadsWrap.replaceChildren(
    ...data.threads.map((th, i) =>
      el(
        'div',
        { class: `mock-thread${i === data.activeThread ? ' active' : ''}` },
        el('div', null, pick(th.title)),
        el('small', null, th.meta),
      )),
  );

  document.getElementById('mock-pane-title').textContent = pick(data.paneTitle);
  document.getElementById('mock-pane-sub').textContent = data.paneSub;

  const feed = document.getElementById('mock-feed');
  feed.replaceChildren(
    el('div', { class: 'mock-msg-user' }, pick(data.userMsg)),
    el(
      'div',
      { class: 'mock-msg-agent' },
      el('span', { class: 'mock-msg-meta' }, pick(data.agentMeta)),
      el('div', null, pick(data.agentMsg)),
    ),
    el(
      'div',
      { class: `mock-card${data.cardTone === 'ok' ? ' ok' : ''}` },
      el('span', { class: 'mock-card-kind' }, pick(data.cardKind)),
      el('div', { class: 'mock-card-title' }, pick(data.cardTitle)),
      el('div', { class: 'mock-card-body' }, pick(data.cardBody)),
      el(
        'div',
        { class: 'mock-card-actions' },
        data.actions.map((act, idx) =>
          el('span', { class: `mock-pill-btn${idx === 0 ? ' primary' : ''}` }, pick(act))),
      ),
    ),
  );

  const contextPane = document.getElementById('mock-context-pane');
  contextPane.replaceChildren(
    el('span', { class: 'mock-label' }, pick(COPY.mockContextLabel)),
    ...data.facts.map((fact) =>
      el(
        'div',
        { class: 'mock-fact-box' },
        el('strong', null, pick(fact.title)),
        el('p', null, pick(fact.body)),
        typeof fact.meter === 'number'
          ? el('div', { class: 'mock-meter' }, el('span', { style: { width: `${fact.meter}%` } }))
          : null,
        fact.sub ? el('p', { class: 'tabular' }, pick(fact.sub)) : null,
      )),
  );

  document.getElementById('scenario-caption').textContent = pick(data.caption);
}

function renderQuickstart() {
  const data = QUICKSTARTS[currentQs];
  if (!data) return;

  for (const id of QS_ORDER) {
    const btn = document.getElementById(`qs-tab-${id}`);
    if (!btn) continue;
    const active = id === currentQs;
    btn.setAttribute('aria-selected', String(active));
    btn.setAttribute('tabindex', active ? '0' : '-1');
  }

  document.getElementById('qs-panel')?.setAttribute('aria-labelledby', `qs-tab-${currentQs}`);
  document.getElementById('qs-desc').textContent = pick(data.desc);
  document.getElementById('qs-code-label').textContent = data.label;
  document.getElementById('qs-code').textContent = data.lines.join('\n');
}

function applyLanguage(lang) {
  currentLang = lang === 'en' ? 'en' : 'zh';
  document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : 'en';
  document.title = pick(COPY.pageTitle);

  try {
    localStorage.setItem('otto.site.lang', currentLang);
  } catch { /* ignore */ }

  for (const btn of document.querySelectorAll('[data-lang]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.lang === currentLang));
  }

  for (const node of document.querySelectorAll('[data-i18n]')) {
    const key = node.dataset.i18n;
    if (key && COPY[key]) {
      if (node.dataset.copied === 'true') {
        node.textContent = pick(COPY.copiedBtn);
      } else {
        node.textContent = pick(COPY[key]);
      }
    }
  }

  renderScenario();
  renderQuickstart();
  renderDocs();
}

hydrateLinks();

for (const btn of document.querySelectorAll('[data-lang]')) {
  btn.addEventListener('click', () => applyLanguage(btn.dataset.lang));
}

const scenarioTablist = document.getElementById('scenario-tablist');
scenarioTablist?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-scenario]');
  if (!btn) return;
  currentScenario = btn.dataset.scenario;
  renderScenario();
  btn.focus({ preventScroll: true });
});
scenarioTablist?.addEventListener('keydown', (event) => {
  const next = nextRoving(SCENARIO_ORDER, currentScenario, event.key);
  if (!next) return;
  event.preventDefault();
  currentScenario = next;
  renderScenario();
  document.getElementById(`sc-tab-${next}`)?.focus({ preventScroll: true });
});

const qsTablist = document.getElementById('qs-tablist');
qsTablist?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-qs]');
  if (!btn) return;
  currentQs = btn.dataset.qs;
  renderQuickstart();
  btn.focus({ preventScroll: true });
});
qsTablist?.addEventListener('keydown', (event) => {
  const next = nextRoving(QS_ORDER, currentQs, event.key);
  if (!next) return;
  event.preventDefault();
  currentQs = next;
  renderQuickstart();
  document.getElementById(`qs-tab-${next}`)?.focus({ preventScroll: true });
});

for (const btn of document.querySelectorAll('[data-copy-target]')) {
  btn.addEventListener('click', async () => {
    const targetId = btn.dataset.copyTarget;
    const source = targetId ? document.getElementById(targetId) : null;
    const text = source?.textContent?.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      btn.dataset.copied = 'true';
      btn.textContent = pick(COPY.copiedBtn);
      announce(pick(COPY.copiedBtn));
      clearTimeout(btn._copyTimer);
      btn._copyTimer = setTimeout(() => {
        delete btn.dataset.copied;
        btn.textContent = pick(COPY.copyBtn);
      }, 1800);
    } catch { /* clipboard unavailable */ }
  });
}

applyLanguage(currentLang);
