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
    'When working across a laptop, a desktop, and a phone, it is hard to track what each local agent is doing. Otto runs a persistent Steward process on your server to hold conversations, task state, and reminders, and dispatches code changes to pi, Claude Code, or Codex CLI on your own computers. Repositories and full session logs remain on local disk.',
    '在笔记本、台式机和手机之间切换工作时，往往很难集中追踪各台机器上的任务进度。Otto 在你自己的服务器上运行一个常驻进程（Steward），统一维护对话、事项状态与待办提醒；涉及读写代码的任务则分发给各台电脑上的 pi、Claude Code 或 Codex CLI 执行，代码仓库与完整会话日志始终留在本地。',
  ],
  heroCtaStart: ['Setup guide', '安装与运行'],
  heroCtaPreview: ['See workflows', '查看典型场景'],
  copyBtn: ['Copy', '复制'],
  copiedBtn: ['Copied', '已复制'],
  factAgents: [
    'Local adapters: pi · Claude Code · Codex CLI · Antigravity',
    '本地适配器：pi · Claude Code · Codex CLI · Antigravity',
  ],
  factOS: [
    'Connectors: macOS · Linux · Windows (outbound connection, no port forwarding)',
    '连接器运行环境：macOS · Linux · Windows（出站连接，无需端口映射）',
  ],
  factHost: [
    'Steward host: Linux VPS (Node.js + SQLite) or Cloudflare Workers',
    '服务端运行环境：Linux VPS（Node.js + SQLite）或 Cloudflare Workers',
  ],
  previewKicker: ['WORKFLOWS', '界面示例'],
  previewTitle: [
    'Four common workflows',
    '日常使用的四个典型场景',
  ],
  previewSub: [
    'Select a tab below (or press Left / Right arrow keys) to switch between workflows.',
    '点击下方标签（或按键盘 ← / → 方向键）切换不同工作流。',
  ],
  scTabDispatch: ['Run a local task', '派发本地任务'],
  scTabPr: ['Follow a GitHub PR', '跟进 GitHub PR'],
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
    'The server persists state in a single SQLite file; your computers connect via outbound WebSockets with no public IP or port forwarding.',
    '服务端使用单个 SQLite 文件持久化状态；本地电脑通过出站 WebSocket 连接服务端，无需公网 IP 或端口映射。',
  ],
  svgT1Title: ['Desktop & Phone Browser', '电脑与手机浏览器'],
  svgT1B1: ['• Chat history + pending cards', '• 对话记录与待处理卡片'],
  svgT1B2: ['• Cmd/Ctrl+K full-text search', '• Cmd/Ctrl+K 全文检索'],
  svgT1B3: ['• Passkey login & optional push', '• Passkey 登录与可选推送'],
  svgLink1: ['Live sync', '实时同步'],
  svgT2Title: ['Linux VPS (or Workers)', '云服务器（或 Workers）'],
  svgT2B1: ['Code paths: queues / timers / PR checks', '常规逻辑：队列 / 定时 / PR 检查'],
  svgT2B2: ['Model calls: routing / summaries', '模型调用：路由判断 / 进度整理'],
  svgT2B3: ['Single-file SQLite + FTS5', '单文件 SQLite + FTS5 数据库'],
  svgLink2Top: ['Outbound WS', '出站连接'],
  svgLink2Bot: ['No inbound port', '免开入站端口'],
  svgT3B1: ['• Spawns pi / Claude Code / Codex', '• 调用本机 pi / Claude Code / Codex'],
  svgT3B2: ['• Worktree isolation, diff & cleanup', '• Worktree 隔离、Diff 查看与清理'],
  svgT3B3: ['• Repos & logs stay on local disk', '• 仓库与完整日志留在本机磁盘'],
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
    'Concrete implementation rules aimed at preventing lost context, API stalls, and accidental side effects during long tasks.',
    '针对长周期任务中常见的上下文遗忘、接口异常与误操作问题，系统在实现上做了以下约束。',
  ],
  bound1Tag: ['State Storage', '状态存储'],
  bound1Title: ['Task progress and project notes stored in SQLite', '事项进度与项目备注独立存入 SQLite'],
  bound1Body: [
    'Thread status, worker reports, and project conventions live in structured tables, and each turn receives a concise snapshot. Compaction on long chats never drops earlier agreements.',
    '事项状态、worker 汇报和项目约定都保存在结构化表里，每轮对话仅向模型注入当前状态摘要，避免长对话压缩历史记录时丢失早期约定。',
  ],
  bound2Tag: ['Less Model Reliance', '减少模型依赖'],
  bound2Title: ['Routine workflows driven directly by deterministic code', '固定流程直接由常规代码驱动'],
  bound2Body: [
    'Timeout checks, retry queues, scheduled PR polling, and completion notices run directly in code without per-tick LLM calls. Pending decision cards still arrive even if a model API fails or hits its daily budget.',
    '超时检测、队列重试、PR 定时轮询与完成通知均直接走确定性的代码逻辑，无需逐次调用大模型。即便模型接口异常或达到单日预算上限，待处理的确认卡片仍会正常送达。',
  ],
  bound3Tag: ['Explicit Approval', '权限确认'],
  bound3Title: ['Side-effecting actions require clicking a confirmation card', '涉及外部变更的操作必须点击确认卡'],
  bound3Body: [
    'Starting or cancelling a PR watch, removing an unmerged worktree, or writing a repo skill file requires clicking its confirmation button — replying "ok" in chat does not execute it. Web search turns also isolate execution tools.',
    '开启或取消 PR 跟进、清理含未合并提交的 worktree、写入仓库技能文件，均需点击对应的确认按钮，在聊天框回复“同意”不会触发执行；联网搜索轮次亦默认隔离执行工具。',
  ],
  bound4Tag: ['Stop Controls', '中断控制'],
  bound4Title: ['Stopping a reply is separate from interrupting a worker', '停止回复与中断本地任务相互独立'],
  bound4Body: [
    'Stopping the current chat reply, interrupting a running local agent, and cancelling a background PR watch are separate controls; cancelling a reply does not kill an active coding run.',
    '终止当前文字回复、中断本地运行中的 coding agent、取消后台 PR 跟进是三个分离的控制项，打断单轮回复不会误停后台正在执行的编码任务。',
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
      { title: ['Follow PR #42 CI status', '跟进 PR #42 CI 状态'], meta: 'watch · github' },
      { title: ['Clean old worktree folders', '清理历史分支目录'], meta: 'audit · 2 machines' },
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
        title: 'mac-studio · pi',
        body: [
          'Edits happen inside an isolated Git worktree; uncommitted changes in your main checkout remain untouched.',
          '文件修改均在独立 Git worktree 内进行，主工作区未提交的改动不受影响。',
        ],
        meter: 38,
        sub: ['Context: 48.2k / 128k tokens', '上下文用量：48.2k / 128k tokens'],
      },
      {
        title: ['Session log', '原始会话视图'],
        body: [
          'Open the Session view to inspect full terminal output and diffs, or send follow-up instructions directly to that worker.',
          '切换至 Session 视图可查看该机器上的原始终端输出与 diff，也可随时补充指令或中止运行。',
        ],
      },
    ],
    caption: [
      'Dispatch tasks from your phone or another laptop; the connector checks out an isolated Git worktree so your active branch stays clean.',
      '从手机或另一台电脑下发任务时，连接器会按仓库策略检出独立 Git worktree，不干扰本地正在开发的分支。',
    ],
  },
  pr: {
    stats: { machines: '2/3', running: '0', waiting: '1', spend: '$0.09' },
    activeThread: 1,
    threads: [
      { title: ['Debug concurrent state refresh', '排查并发状态刷新失败'], meta: 'pi · mac-studio · idle' },
      { title: ['Follow PR #42 CI status', '跟进 PR #42 CI 状态'], meta: 'watch · 1 failing check' },
      { title: ['Clean old worktree folders', '清理历史分支目录'], meta: 'audit · 2 machines' },
    ],
    paneTitle: ['Follow PR #42 CI status', '跟进 PR #42 CI 状态'],
    paneSub: 'PR Watch · pull/42',
    userMsg: [
      'Poll PR #42 every 15 minutes on this thread and notify me if CI fails or new review comments arrive, without starting a worker yet.',
      '在此事项下每 15 分钟检查一次 PR #42，若 CI 失败或有新评审意见再提醒我，暂不启动本地 worker。',
    ],
    agentMeta: ['PR CHECK · 2M AGO', 'PR 检查 · 2 分钟前'],
    agentMsg: [
      'Job unit-linux failed on commit 9f3c21a (1 assertion failure in cookie-options.test.ts). No merge conflicts; 1 review comment summarized.',
      '提交 9f3c21a 上的 unit-linux 任务失败（cookie-options.test.ts 存在 1 处断言未通过）；无合并冲突，已同步摘录 1 条评审意见。',
    ],
    cardTone: 'warn',
    cardKind: ['PR FAILURE SUMMARY', 'PR 检查异常摘要'],
    cardTitle: [
      'Dispatch a worker on thinkpad-linux to fix cookie-options.test.ts?',
      '是否在 thinkpad-linux 上启动 worker 修复该测试失败？',
    ],
    cardBody: [
      'Status polling and log extraction ran on the server without keeping a local coding agent running.',
      '状态轮询与失败日志截取均由服务端直接调用接口完成，期间无需保持本地 agent 在线。',
    ],
    actions: [
      ['Start worker', '启动 worker 修复'],
      ['View log excerpt', '查看报错片段'],
    ],
    facts: [
      {
        title: ['Server-side polling', '服务端定时轮询'],
        body: [
          'Timers run inside the Steward process, survive restarts, and consume zero model tokens while status is unchanged.',
          '轮询定时器运行在服务端进程内，重启后自动恢复，状态无变化时不消耗模型 token。',
        ],
      },
      {
        title: ['Read-only boundary', '只读权限边界'],
        body: [
          'PR watches only read status and logs; Otto never merges PRs, re-runs CI, or pushes commits automatically.',
          'PR 跟进仅做状态与日志读取，不会自动合并代码、重跑 CI 或推送提交。',
        ],
      },
    ],
    caption: [
      'The server polls CI status, extracts failing log excerpts, and checks mergeability without keeping a local agent running.',
      '服务端负责定时轮询 CI 状态与合并冲突并截取关键报错日志，出现异常后再由你决定是否派发修复任务。',
    ],
  },
  memory: {
    stats: { machines: '2/3', running: '0', waiting: '1', spend: '$0.18' },
    activeThread: 0,
    threads: [
      { title: ['Control Plane · Memory & Skills', '控制面板 · 记忆与技能'], meta: 'notes + repo skills' },
      { title: ['Debug concurrent state refresh', '排查并发状态刷新失败'], meta: 'pi · mac-studio · done' },
      { title: ['Follow PR #42 CI status', '跟进 PR #42 CI 状态'], meta: 'watch · green' },
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
      { title: ['Follow PR #42 CI status', '跟进 PR #42 CI 状态'], meta: 'watch · green' },
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
    label: 'Linux VPS bundle',
    desc: [
      'Build the single-file Node.js bundle on your dev machine, copy dist/node/steward-node.mjs and dist/ui/ to your Linux server behind an HTTPS reverse proxy, and configure .dev.vars:',
      '在开发机编译单文件产物，将 dist/node/steward-node.mjs 与 dist/ui/ 拷贝至 Linux 服务器，配置 .dev.vars 与 HTTPS 反向代理即可运行：',
    ],
    lines: [
      'corepack pnpm install --frozen-lockfile',
      'corepack pnpm --filter @isaac2ingrid/steward build:node',
      'mkdir -p apps/steward/dist/ui',
      'cp -R apps/steward/ui/. apps/steward/dist/ui/',
      '',
      '# Subsequent upgrades when deploy/aliyun.env is set:',
      'pnpm deploy:vps',
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
      'otto status',
    ],
  },
};

const DOCS_ITEMS = [
  {
    path: 'docs/self-hosted.md',
    title: ['Self-Hosted Server Guide', '服务器部署手册'],
    desc: [
      'systemd unit setup, HTTPS reverse proxy with WebSocket support, online SQLite backups, Web Push, and optional web search.',
      'systemd 配置、HTTPS 与 WebSocket 反向代理、SQLite 在线备份、手机通知与可选搜索配置。',
    ],
  },
  {
    path: 'docs/agent-connect.md',
    title: ['Connector Setup & Troubleshooting', '连接器安装与排错'],
    desc: [
      'Background service setup on macOS, Linux, and Windows, directory allowlists, proxy variables, and log diagnostics.',
      'macOS、Linux、Windows 后台服务自启说明、仓库目录授权、代理设置和常见连不上时的排查命令。',
    ],
  },
  {
    path: 'docs/usage.md',
    title: ['Daily Usage & Owner API', '使用说明与接口'],
    desc: [
      'How task routing works, choosing local agent models per machine, viewing raw worker sessions, and calling the Owner API.',
      '日常怎么派任务、按机器选择本机 agent 模型、查看原始会话日志，以及 Owner API 的调用格式。',
    ],
  },
  {
    path: 'docs/pr-watches.md',
    title: ['GitHub PR Watches', 'PR 跟进说明'],
    desc: [
      'Confirmation cards, required GitHub permissions, commit statuses vs Actions checks, and known limitations.',
      '确认卡机制、GitHub 令牌权限说明、statuses 与 Actions 检查的区别，以及目前没覆盖的边界。',
    ],
  },
  {
    path: 'docs/design/steward.md',
    title: ['Steward Design Notes', 'Steward 架构说明'],
    desc: [
      'Why state lives in SQLite, how plain code and LLM turns divide work, serial turns, and crash recovery.',
      '数据库表怎么设计、普通代码和模型怎么分工、串行轮次控制以及进程重启后的恢复方式。',
    ],
  },
  {
    path: 'docs/spec.md',
    title: ['Protocol & Product Spec', '协议与规格文档'],
    desc: [
      'Wire messages between Steward and Connector, state transitions, evaluation scripts, and ADRs.',
      '服务端与连接器之间的消息格式、状态流转定义、评测脚本说明以及历次架构决策记录（ADR）。',
    ],
  },
];

const SCENARIO_ORDER = ['dispatch', 'pr', 'memory', 'audit'];
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
