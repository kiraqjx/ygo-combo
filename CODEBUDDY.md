# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

## 常用命令

- `npm install` — 安装依赖（Vue 3 / Vite / Pinia / Vue Router / fflate / ocgcore-wasm）。
- `npm run dev` — 开发服务器，固定端口 5173；`/pics/*` 由 Vite 代理到 `cdn.233.momobako.com/ygopro/pics`，用于卡图同源（canvas 可读像素，GIF 导出依赖这一点）；`/api/llm/*` 代理到 `api.deepseek.com`、`/api/anthropic/*` 代理到 `api.anthropic.com`（AI 代打与 AI 生成 skill 包用，目标可用 `VITE_LLM_PROXY_TARGET` / `VITE_ANTHROPIC_PROXY_TARGET` 覆盖）。
- `npm run typecheck` — `vue-tsc --noEmit`，本仓库唯一可用的静态检查；提交前跑这个。
- `npm run build` — `vue-tsc -b && vite build`，产物在 `dist/`；纯静态站点，History 路由需服务端回退到 `index.html`。
- `npm run preview` — 预览构建产物（同样带 `/pics` 代理）。
- `npm run assets:duel` — 跑 `scripts/fetch-duel-assets.mjs` 拉取对局资源到 `duel-assets/`（ocgcore 官方 Lua 脚本、MyCard 先行服脚本、卡名 / 效果描述）。仓库里已经有一份，除非内核升级或要跟上先行卡才需要重跑；**重跑默认复用 `.cache/duel` 里的上游包**，要拉最新的加 `-- --refresh`（否则会以为更新了、其实还是旧脚本）。先行卡（MyCard 客户端已能打、KONAMI 还没发售）的脚本只从 `mycard/ygopro-scripts` 挑「不依赖 MyCard 私有辅助函数」的那些，其余跳过（见 README「数据来源」）。上游都还没写脚本的新卡，可把 `c<卡号>.lua` 放进 `duel-assets/scripts/local/`（优先于所有内置目录，`--refresh` 也不会删），或用 `--edopro=<任意本地目录>` / `--scripts-from=<tar.gz 或 zip 脚本包>` 让脚本自动扫描导入（只补上游没有的卡号、不覆盖 local 已有文件、仍按 aux 引用筛兼容性）。前者适合本地 EDOPro 安装目录，也适合 MC 超先行补丁解压出来的目录。`--superpre` 另外整批接超先行服（与 mycard.world 的 `#/superpre` 页面同一套接口）：能对上正式卡号的脚本改名进 `local/`，还没有正式密码的新卡按临时编号（`1013xxxxx` / `1002xxxxx`）进 `scripts/superpre/`，卡数据（包里的 `test-release.cdb`）合并进 `cards.json`，卡图落到 `pics/superpre/`，前端卡库条目生成 `duel-assets/superpre-cards.json`。
- 仓库没有配置 lint 与测试框架（无 Vitest / ESLint 脚本），也没有单测可跑。新增测试前需先引入 runner 并补充 npm script。

## 架构概览

纯前端、无后端。持久化通道：IndexedDB（卡库缓存 `ygo-infer`、录像与解析结果 `ygo-skill`）与 localStorage（手坑配置、卡组、自定义卡、主题、暂存 `ygo-duel-checkpoints`、AI 配置 `ygo-ai-config`、生成好的 skill 包 `ygo-skill-bundles`）。「使用说明」页提供全站数据的导出 / 导入（`lib/siteData.ts`，覆盖式恢复，不含 API Key 与卡库缓存）。许可证是 AGPL-3.0-only（见根目录 `LICENSE`）。

### 领域模型（`src/types.ts`）

只剩三件事：`CardData`（卡库归一化结果）、`DeckEntry`（卡号 + 卡名 + 张数）、以及录像侧的 `ReplayAnalysis`（见 `lib/duel/replay.ts`）。

combo 工坊（`Combo` / `ComboLine` / `Timing` / `CardMove` 那套手工编排模型）已经整体删除：现在「展开路线」就是一份绑定到卡组的 `.yrp` 录像。**不要再往这里加回手工模型**，否则又会分叉出两套路线语义。

### 手坑定义（`src/lib/handtraps.ts` + `stores/handtraps.ts`）

`BUILTIN_HANDTRAPS` 是内置手坑（卡号 + 类别 + 配色），用户配置存 localStorage。起手样本（`skillSamples.ts`）与 skill 包的「手牌角色 / 手坑起手」会用到它；**手坑变了要让上层重新计算**，`store.version` 计数器就是给 `computed` 建依赖用的。

注意：这里的 `category` / `counting` 只是起手统计用的分类，与「录像手坑判定」（`lib/duel/replayHandtraps.ts`）是两套规则，互不共享配置。模块级 `HANDTRAPS` / `HANDTRAP_MAP` 注册表已随推演内核一起删除。

### 卡库与检索（`src/lib/cardDb.ts`、`src/lib/search.ts`、`stores/cards.ts`）

`loadCardDatabase()` 下载 ygocdb 的 `cards.zip` → fflate 解压 → `normalizeCard()` 归一化成 `CardData`（含小写检索串 `blob`、`frame`、`kinds`）→ JSON 缓存进 IndexedDB（`ygo-infer` DB）。卡库不可用时 `remoteSearch()` 回退到 ygocdb 在线接口。`searchCards()` / `collectFacets()` 在内存里做筛选与聚合，`App.vue` 挂载时触发 `cardStore.init()`。

卡库只有正式服数据，因此有两条补充路径：一是 `loadCardDatabase()` 末尾把 `duel-assets/superpre-cards.json`（超先行临时编号卡，`assets:duel --superpre` 生成）解析成 `CardData` 合并进 `library`（同号以主卡库为准，`registerSuperPreIds()` 登记的号卡图改走同源 `duel-assets/pics/superpre/`）；二是 `lib/customCards.ts` 手动录入（只写卡名、种类、可选卡号与效果文本），存 localStorage，并由 `stores/cards.ts` 与下载卡库合并成 `store.cards`（`library` 是下载库，`custom` 是本地库），检索、卡组、启动率都走合并后的列表。自定义卡没有卡图，`App.vue` 用捕获阶段的全局 `error` 监听把失败的 `<img>` 换成 `CARD_PLACEHOLDER`。

### 文本推断（`src/lib/infer.ts`）

只剩启动率要用的部分：`pickEffectSegment()` 从多段效果（①②③）里挑要建模的那一段（优先墓地 / 丢弃触发段），`inferRateOps()` 抽出抽滤算子——看牌库顶 N 张 / 其中拿 M 张 / 其余送墓或除外，抽 N 张，丢 N 张手卡。原来的「卡片 → 时序草稿」推断（`inferTiming` / `autoRuleMoves` / `suggestHandtraps` / `suggestTargets` / `reuseAutoIds`）已随工坊删除。

### 真实对局引擎（`src/lib/duel/*`）

用 `ocgcore-wasm`（优先 JSPI 异步版，`!wasm?url` 加载，不支持时退回同步版）真正跑 OCG 规则。`duel-assets/` 是它需要的本地资源：`scripts/official/*.lua`（卡片脚本）、`scripts/mycard/*.lua`（先行服脚本）、`scripts/superpre/*.lua`（超先行服临时编号脚本）、`pics/superpre/*.jpg`（超先行卡图）、`descriptions.json`、`strings`，由 `session.ts` 通过 `ScriptStore` / `loadDuelStrings()` 喂给内核。`ScriptStore` 找卡片脚本的顺序是 `local → superpre → official → pre-release → mycard → unofficial → pre-errata`，都没有才用空脚本兜底并记进 `missingCodes`（界面黄条提示「效果不会生效」）。`mycard/`、`superpre/`、`mycard-compat.lua` 都由 `assets:duel` 生成。

**公共脚本加载顺序由 `ScriptStore.helpers()` 写死**，`helpers.json` 只提供清单：`constant → utility → 其余（proc_* 等）→ SUPER_PRE_HELPERS → mycard-compat`。`SUPER_PRE_HELPERS = [mycard-snapshot, mycard-utility, mycard-restore, mycard-procedure]` 是超先行 / 先行服的兼容层：MyCard 的 `utility.lua` 第一行是 `Auxiliary={}`，直接加载会把 EDOPro 的 aux 全清空（实测 20 张官方卡当场注册失败），所以先快照、再加载 MyCard 的 utility、然后逐键还原 EDOPro 的实现、最后补 MyCard 的 `procedure.lua`（提供 `aux.AddXyzProcedure` / `aux.AddSynchroProcedure` 等）。**这个顺序不能调**，改了就静默退化。`mycard-compat.lua` 必须最后（覆盖 `GetID`、补 MyCard 独有常量，早于 utility 会拿到 nil）。

`mycard-compat.lua` 还补了 10 个 **MyCard 内核内置、Lua 侧没有**的 `Card.*` 判定：`Card.IsFusionType` / `IsFusionAttribute` / `IsFusionRace` / `IsFusionCode` / `IsFusionSetCard` / `IsLinkType` / `IsLinkAttribute` / `IsLinkRace` / `IsLinkCode` / `IsLinkSetCard`。它们是**懒崩**的：初始化不报错，等求值 Link / 融合召唤条件时才 `attempt to call a nil value`，界面表现就是「卡能加进卡组、但点了不能召唤」（22011594 龙魔导降灵师踩过）。新增超先行脚本如果又出现「出不了场」，先查脚本里有没有别的 MyCard 专有 API。

`ScriptStore` 请求脚本时会带 `?v=<manifest.builtAt>`：不带版本号时浏览器按 `cache-control` 能缓存一天，重跑 `assets:duel` 补了脚本/改了垫片，页面却还在跑旧文件（表现为「明明补了还是不行」）。

- `session.ts`（`DuelSession`）—— 对象生命周期的唯一入口：`start()` / `waitForEnd()` / `snapshot()`；内部循环 `process()` → 处理消息 → `takeQuestion()` → 取答复。三种答复来源：界面（`waitAnswer`）、沙包 AI（`autoRespond`）、录像回放（`rawQueue` 直接把 `.yrp` 里的响应字节按序喂回）。同时产出三样东西：`state`（界面状态）、`logs`（人类可读日志）、**`signals`（结构化事件流）**。
- `signals` 是录像手坑分析的**唯一数据源**。`DuelSignalKind` 见 `types.ts`：`summon` / `spsummon` / `flip`（召唤宣言）、`summoned` / `spsummoned` / `flipsummoned`（内核确认成功，被无效就没有这条）、`set`、`position`（表示形式变化）、`chain`（发动）、`solving` / `solved` / `negated`（连锁结算）、`move`（带 from/to 区域位与 reason 位）、`draw`、**`prompt`（SELECT_CHAIN 提问，表示此刻轮到谁决定要不要连锁）**。新增 kind 时要同步检查 `replayHandtraps.ts` 的 switch。
- `replay.ts`（`analyzeReplay(bytes, resolveName)`）—— `.yrp` → `ReplayAnalysis`：`steps` / `decisions` / `handtrapHits` / `handtrapHitsAll` / `drawHandtraps` / `analysisVersion` / `incomplete`。解析是确定性的（同种子 + 同响应序列 → 同结果），所以结果会被缓存。`handtrapHits` 只留前 `HANDTRAP_MAX_STEP`（20）步（skill 包语义），`handtrapHitsAll` 是同一份判定的全量，展开图与手坑报告用后者，不必为重放而多跑一次内核。
- `replayHandtraps.ts`（`analyzeHandtrapHits(signals)`）—— 从事件流反推「假设对手手上有这些卡，能在第几步打断」。规则细节见下一节。
- `replayFlows.ts`（`analyzeCardFlows(signals, { picks })`）—— 从事件流归因出「哪张卡把哪张卡从哪个区域挪到哪个区域」（`ReplayAnalysis.flows`），供检索图使用。归因三条路：`solving` 指向的连锁发动卡、发动前缓存的 COST 移动、召唤前缓存的素材 / 解放移动；拿不到来源的移动直接丢弃。**从卡组出发的移动还要求「玩家那回合明确选过这张卡」**（`picks` 由 `replay.ts` 的 `collectFlowPicks()` 从选卡提问的响应里解析，带信号下标）：抽卡、割草式随机堆墓、强贪式随机除外都由内核自己决定、不产生选卡提问，强行连成「A 检索 B」会骗人，所以一律不画。选卡配额还带「结算段号」（选卡时 `solving` 的连锁号）：连锁后进先出，c2 结算中选的卡会漏到 c1 的结算里，把 c1 的随机抽回手卡当成检索，段号对不上就作废（段号 0 = 发动时选的卡，对哪一段都算数）。**改归因规则要 +1 `FLOW_VERSION`**；`flows` 随解析结果缓存在 IndexedDB，版本对不上或没有 `flows` 时检索图会按需重放并写回（不占 `HANDTRAP_ANALYSIS_VERSION`，手坑规则没变就不该让旧结论失效）。
- `replayStore.ts` —— IndexedDB（`ygo-skill` / `replays`）存 `.yrp` 原始字节 + 解析结果，卡组删除后录像不自动清理（保留 `deckName` 供孤儿清理）。
- `replayPoster.ts` —— `renderComboChainPoster()`：只吃 `ReplayAnalysis`（steps / openingHand / handtrapHits）画展开链长图，因此**没有 signals 时也能出图**；手坑点**优先按信号下标对齐**（`ReplayHandtrapHit.signal` ↔ `ReplayStep.signal`，日志写入时记下它对应的事件流位置）：同一张卡可能在场 / 在墓地各发动一次，只按卡名找会贴到前面那次同名发动上（典型：墓地效果不吃泡影，泡影的命中被贴到墓地效果那一步）。拿不到下标时才回退「同回合 + 卡名」匹配，仍然贴不上的落到图末「未对上步骤的手坑点」。贴好后 trigger 里的步号会改写成节点序号，两个口径不会混。长图用 `handtrapHitsAll`（全量，不受 20 步限制），节点上限 `MAX_NODES`（96）是另一回事。`actionableSteps()` 是「展开步数」的唯一口径（滤系统行 + 抽卡阶段常规抽牌），展开图与手坑报告都调它，两边的「第 N 步」才对得上。长图倍率同时受画布高度与总像素约束（移动端 Safari 容易超限）。
- 其他：`yrp.ts`（解析录像头 / 卡组 / 随机种子）、`checkpoint.ts`（暂存恢复）、`interaction.ts` + `response.ts`（提问 → 候选 / 响应字节）、`auto.ts`（沙包策略）、`random.ts`（xoshiro256** 洗牌）、`labels.ts`（选项文案）、`cards.ts`（卡组 → 内核卡数据）。

**约定：`DuelSignal` 只增不改语义**。改动信号结构或 kind 时要同时梳理 `replayHandtraps.ts` 与任何对 `signal.kind` 做 switch 的地方（目前只有它一个消费者）。

### 录像手坑判定（`src/lib/duel/replayHandtraps.ts`）

当前只支持 7 张：灰流丽、灵王的波动、无限泡影、屋敷童、幽鬼兔、锁鸟、原始生命态 尼比鲁。抽卡型手坑（增殖的G / 欢聚友伴系列）故意不体现。

`analyzeHandtrapHits()` 返回**全量**命中点（不限步数）；截断到前 `HANDTRAP_MAX_STEP`（20）步由 `replay.ts` 做——那个 20 是给 skill 包用的（再往后已经不算「展开被拦」），**展开图与手坑报告要用完整展开**，所以走 `handtrapHitsAll`。别把截断再挪回判定函数里。每条 hit 还带 `signal`（命中发生在事件流的哪个下标），展开图靠它把点贴到正确步骤上，别删。

判定原则：

- **灰流丽**：`卡组 → 手卡 / 墓地 / 怪兽区`，且那次移动必须是效果处理（`reason` 含 `EFFECT`、不含 `COST`）。`REASON` 位掩码必须对照 `duel-assets/scripts/constant.lua`（`RELEASE=0x2`、`MATERIAL=0x8`、`EFFECT=0x40`、`COST=0x80`、`RULE=0x400`），**从卡组解放 / 当素材送墓不吃灰流丽**。
- **屋敷童**：按结算结果判，`墓地 → 手卡 / 卡组 / 怪兽区 / 除外`；**不要按「发动位置在墓地」判**——墓地发动的效果去卡组找牌属于灰流丽。
- **灵王的波动**：效果里含「把怪兽特殊召唤」就能无效整次发动。判据是「某条连锁的结算里出现了非场上区域 → 怪兽区」的移动，命中点记在**发动那一步**（不看 `reason`，仪式 / 融合召唤的 reason 常带 `MATERIAL` / `SPSUMMON`）。
- **幽鬼兔**：只能炸**已经表侧表示在场**的卡。用 `faceUp` 账本（`MOVE` 的 position、`SET`、`position` 信号维护）+ 「变表侧至少隔了一条信号」判断，卡片自身发动（手卡置入魔陷区、盖卡刚翻开）炸不了。
- **无限泡影**：场上的怪兽效果发动即可（能力允许时提前盖放，文案里注明当回合盖的不能发）。
- **锁鸟**：只在**主要阶段（4 / 16）**、只由 `卡组 → 手卡` 的检索触发，每局一次；抽卡与特召都不触发。
- **尼比鲁**：累计第 5 次我方召唤 / 特召。召唤要先记 `pending`，等内核的 `SUMMONED` / `SPSUMMONED` / `FLIPSUMMONED` 确认后才计数（被神字辈无效的召唤不计数）。
- **自排连锁**：对手只能在整条连锁排完后响应最后一条。用 `prompt` 信号判断——两条 `chain` 同一人、连锁号相邻、中间没有轮到 player 1，就把前一条记为「盖住」。这些命中点**不删除**，而是 `dodged: true` + `dodgeNote`，让 AI 从文档里学到「自排连锁能规避手坑」。连锁定位要用 `chainId:chainSize`（连锁号每次组连锁都从 1 重来）。

**约定：改判定规则必须 +1 `HANDTRAP_ANALYSIS_VERSION`**。解析结果按版本号缓存在 IndexedDB 里，版本对不上 `SkillsView` 会显示「手坑分析已过期」并隐藏旧结论，点「重新解析」才重跑内核。

### Skill 包（`src/lib/skill.ts`、`src/lib/skillBundle.ts`、`views/SkillsView.vue`）

把卡组 + 启动率配置 + 绑定的录像（**唯一的路线来源**）+ 手坑定义拼成给 AI 读的 Markdown / 分片包（`00-router.md` + `20-replay-*.md` + `90-fallback.md` + `cards/`）。手坑表的单元格文案由 `replayHandtraps.ts` 的 `hitNameText()` / `hitConsequenceText()` 生成，规避条目会带脚注 `HANDTRAP_FOOTNOTE`。

`buildSkillBundle()` 用**录像起手**（`analysis.openingHand`）把录像挂到启动点——单卡动点要求起手有那张卡，两卡 combo 要求两张同时在起手。命中的录像写进 `BundleStarter.replays`，`starter.file` 指向该录像分片；`manifest.schemaVersion` 为 5。`skillContext.ts` 的 prompt 索引会额外生成「启动点 → 路线文件」的紧凑摘要，避免 router 被 `ROUTER_MAX` 截断后模型不知道读哪个分片。

`buildSkillCoverage()` 的 routes / branches / handtraps / endBoard 四项全部由录像推导（可解析份数、命中点数量、跑到终局的份数）；没有录像时只能靠 `90-fallback.md`。

录像步骤有两处**必须压缩**，否则 AI 复现不出完整展开：`actionableSteps()` 滤掉「C1 结算 / 连锁结束」这类系统行（一份展开里这类行占一半以上），单步决策只留前 `REPLAY_STEPS_MAX`（36）步我方动作；`20-replay-*.md` 的「决策序列」按阶段用 `→` 串成一行而不是逐条列出——150+ 条逐行会到 5 KB 以上，把分片顶出 `read_skill` 的截断线，模型只读到抽卡阶段。录像里出现过的卡（名字从步骤文本的 `「…」` 抠，只认卡组里真有的）也会生成 `cards/<code>.md`，否则模型不知道「检索谁」「墓效干什么」。

**AI 生成 skill 包**（`lib/ai/skillWriter.ts`，入口是 `SkillsView` 的「AI 生成 skill 包」按钮）分两步：先照常 `buildSkillBundle()` 得到本地骨架，再把「卡组构筑 + 分片包文本 + 手坑报告」拼成 prompt 交给模型；模型只返回 `{ files: { "<dir>/xx.md": "…" } }`，合并进骨架（同路径覆盖）。**不传 `manifest.json` 给模型改**（本地生成），模型失败时不动现有包。按钮与「生成 skill 包」都要求 `config.enabled`（见 AI 设置），否则置灰。

**生成结果按卡组持久化**（`lib/skillBundleStore.ts`，localStorage `ygo-skill-bundles`，含 `source: 'local' | 'ai'` 与全量文档）：切 tab / 刷新后 `restoreBundle()` 从存档还原，**只有再点一次生成才会覆盖**。每个文件都能在预览区直接编辑（`saveEdit()` 写回 `bundle.files` 并落盘），也能「新增文件」（路径自动补 `<dir>/`，落到「自定义」分组）；`fileGroups` 的分组规则之外的文件不能被丢掉。

### AI 设置（`views/AiSettingsView.vue`、`lib/ai/config.ts`）

AI 配置从「对战区」的弹窗**提取成了独立 tab**（路由 `/ai`，导航「AI 设置」），`components/ai/ModelSettings.vue` 已删除。

`AiConfig` 只留用户真的需要决定的字段：总开关 `enabled`、协议 `protocol`（`openai` / `anthropic`）、`baseUrl`、`apiKey`、`model`。改动**防抖 250ms 自动保存**（`onBeforeUnmount` 还会再落一次盘），没有「保存」按钮。

采样 / 运行参数（温度 / `maxTokens` / 超时 / `thinking` / `jsonMode` / `planOnStart` / `toolRounds` / `skillBudget`）**在 `AiConfig` 里，界面上可编辑**，只是默认值取 `RECOMMENDED_TUNING`（`lib/ai/config.ts`）：温度 0.2、决策 `maxTokens` 512、超时 60s、`thinking` 关、`jsonMode` 开、`planOnStart` 开、`toolRounds` 2、`skillBudget` 24000。设置页的「恢复推荐参数」只写回这一组，不动地址 / 密钥 / 模型。

改推荐值时把 `TUNING_VERSION` +1：`loadAiConfig()` 发现版本对不上会整组落回新推荐值（老配置里那些值是旧版本的写死默认，留着会和新默认对不上）；用户自己改过之后再存就带上新版本号，不会被重置。生成 skill 包时 `skillWriter.ts` 用 `SKILL_GENERATION_LIMITS` 兜底抬高到 8192 token / 180s，不额外占用户选项。

- `isAiReady(config)` = 有 key + 有模型名；`isAiActive(config)` = `enabled && isAiReady`。**判断「能不能用 AI」一律用 `isAiActive`**：`DuelView` 的 AI 代打按钮、`SkillsView` 的 AI 生成按钮都靠它置灰。
- 各页面 mount 时 `loadAiConfig()` 读一次即可（路由切换会重新挂载）；`DuelView` 的 `liveAiConfig` 仍是传给 `AgentRunner` 的引用。
- 切换协议时只覆盖「还是上一个协议默认值」的 `baseUrl` / `model`（`AI_PROTOCOL_PRESETS`），用户自己填的网关不会被冲掉。
- **密钥只在本机**：没有后端，`apiKey` 只写进 localStorage 的 `ygo-ai-config`，页面发请求时读取；**不要**把它写进对局记录、AI 决策日志（`DuelView.buildAiLogReport()` 固定输出「密钥：已省略」）、skill 包或任何导出物。设置页底部有独立的「密钥与隐私」说明块，改存储位置时要同步改它，否则界面承诺和实现会对不上。

### AI 代打（`src/lib/ai/*`）

`DuelView` 开「AI 代打」后由 `AgentRunner` 接管我方应答。它只是 `session.answer()` 的又一个调用方，**不改内核循环**：`onQuestion` 拿到提问 → 算响应 → 交回 `session.answer()`。

状态机是「规划 → 执行 → 打断重规划」：

1. `planRoute()` 在**轮到我方决策的第一次提问**触发（不再限定 `idle`：这套构筑的展开从抽卡阶段就开始了，等到主要阶段才规划，前面几条连锁已经按单步直觉打完，路线接不上），把起手 / 卡组 / skill 索引交给模型，产出 `Plan`（route / goal / steps / avoid / handtraps）。**与起手匹配的录像路线（`pickReplayRoute`，完整步骤）直接拼进规划 prompt**，不指望模型自己想起来 `read_skill`——路线就是本卡组的真打法，规划偏离它，后面按路线执行时必然步步对不上。规划阶段仍允许 `read_skill` 按需读分片（**规划不用 json 模式**，因为 json mode 与 tools 同时用容易被网关拒绝，改为从文本里抠 JSON）。
2. `Plan` 在手时**执行段不调模型**：`matchPlanStep()` 用「动作词 + 卡名」对上候选就照路线走；对不上由 `executeRoute()` 本地裁定（连锁放弃响应、主要阶段收尾、取牌按 墓地 > 卡组 > 手卡 > 场上 顺序），解放 / 弃手卡 / 格位也不逐条问模型。这一步是用户明确要求的「路线定了直接打」。**两个例外**：`option`（效果分支）候选只有「伤害改变 / 盖放魔陷」这种脱离卡名的名字，一律交给模型；`yesno` 的效果确认（`SELECT_EFFECTYN`）按路线点名的卡判——路线写了要发动的卡就答「是」，否则 `autoRespond` 固定答「否」会把链路断在这里。
3. `decide()` 只用于三种情形：**还没有 Plan**（规划失败 / 未开规划）、**刚检测到打断、新 Plan 还没拿到**、以及上面的 `option` 分支提问。它发「局面 + 编号候选 + Plan」的小 prompt，用 json 模式且不带工具。
4. `scanSignals()` 每步只看新增的 `signals`：对手 `chain` 或 `negated` 记为打断，下一次规划前重规划。跨回合清空 `Plan`。

**偏离判定只有四个信号**（故意保守，避免正常展开被反复重规划）：跨回合、对手打断、`planExhausted()`——即 route 里点名要用的卡**全部**进了墓地 / 除外、`unmatched >= MAX_UNMATCHED`——即连续 3 步路线都没覆盖到当前岔路。卡组内容不可见，所以用 `cardZones()` 从信号流重建每张卡最后一次落点；从没移动过的卡视为仍在手卡 / 卡组。手动接管后 `reset()` **保留 Plan 与 usedSteps**（只清 history 与信号游标），重新接管会继续照原路线执行。

关键约束：

- **候选必须枚举成 1 起的编号**，模型只回编号，编号 → `OcgResponse` 是确定性映射（`question.ts`）。选卡 / 解放 / 数值是**多选**（`action` 是编号数组，具体组合由 `buildAnswerResponse` 组装，因为 2^n 种组合没法枚举）；表示形式是单选。格位（`place`）与排序（`sort`）仍走 `autoRespond`：格位候选多、选错会被判非法，`SORT_CHAIN` 的响应编码在既有实现里本来就走 `SORT_CARD` 兜底。
- 多选如果「必须全选」（可选项数 = `min`）就直接作答，不问模型。多选模型连续两次给不出合法组合时整体降级为 `autoRespond`，不猜组合。
- **`handled` 去重不能用「见过就跳过」**：内核 `RETRY` 会把**同一个提问对象**重新抛出（见 `session.ts` 的 `resolveAnswer(..., true)`），跳过就永久卡死。现在用 `busy`（并发去重）+ `answered`（已提交，再出现说明是 RETRY，允许重算）。
- 模型返回空白 `content`（JSON 不合规被 API 换成空格、`finish_reason` 仍是 `stop`）必须显式判空并重试。
- 两次都拿不到有效动作时退到最保守动作（放弃响应 > 结束回合），不能让内核空转。
- 请求层 `provider.ts` 支持两套协议，`chat()` 按 `config.protocol` 分支：OpenAI 兼容走 `/chat/completions`（`response_format` / `thinking` / `tool_calls`），Anthropic 走 `/v1/messages`（`x-api-key` + `anthropic-version`，工具在 `toAnthropicMessages()` 里转成 `tool_use` / `tool_result`，**相邻同角色消息必须合并**，否则 Anthropic 报 roles 不交替）。Anthropic 没有 `response_format`，`json` 只在 system 里追加「只输出 JSON」；extended thinking 要求 `max_tokens > budget_tokens`，预算不够就不传。**改消息结构要同时照顾两套协议**。
- **接口地址是用户自由填写的**（`config.baseUrl`），协议只决定请求格式，不绑定服务商：任何 OpenAI 兼容服务（DeepSeek / OpenAI / OpenRouter / vLLM / New API…）、任何 Anthropic 兼容服务都能用。`provider.ts` 的 `splitUrl()` 只对路径补后缀，query 会原样保留（Azure 的 `?api-version=` 这类网关）；`AI_QUICK_TARGETS` 只是设置页的示例按钮，**不要把它写成白名单**。
- 反代只是默认值：`/api/llm` → `api.deepseek.com`、`/api/anthropic` → `api.anthropic.com`（Vite `server.proxy` / `preview.proxy`，生产要在反代上配同样 location，目标可用 `VITE_LLM_PROXY_TARGET` / `VITE_ANTHROPIC_PROXY_TARGET` 覆盖）。浏览器直连 Anthropic 需要 `anthropic-dangerous-direct-browser-access: true`，`provider.ts` 已固定带上。
- 配置存 localStorage（`ygo-ai-config`），不进 skill 包、不写对局记录。`AgentRunner` 持有 `liveAiConfig` 引用，设置改动即时生效；**总开关关着时 `DuelView` 的 AI 代打按钮置灰**，不能靠绕过界面启动。
- **skill 输入必须带当前卡组的录像**（`DuelView` 的 `skillBindings` / `loadSkillBindings()`）：录像就是路线来源，`skillCache` 的 key 里含录像 id 列表，换录像要重算。之前这里传空数组，模型永远看不到录过的打法。
- **单步决策的候选会带上录像步骤标注**：`pickReplayRoute()` 用「手卡 + 墓地 + 当前连锁」当焦点挑一条录像，`alignReplaySteps()` 按「动作词 + 卡名」把候选对到 `〔录像第 N 步：…〕`（`不发动` / `取消` / `结束回合` 这类负面候选不参与，否则「不发动」会被当成「发动」）。`option`（效果分支）提问还必须在标题里点名「正在处理『某卡』的效果」，因为内核只给「伤害改变 / 盖放魔陷」这种脱离卡名的分支名，模型单看候选无法和录像对上。
- **`AgentTrace` 是对外的决策日志**：每条带 `kind`（`plan` / `replan` / `decide` / `auto` / `fallback` / `interrupt`）、`title`、`detail`、模型给的 `reason`、候选数、耗时与 token 增量（`mark()` / `since()` 算差值）。`DuelView` 把它渲染成右侧日志抽屉，`auto` 类（唯一候选、只能全选）默认折叠。加新的决策分支时记得补一条 trace，否则界面上会「跳步」。**日志抽屉支持「导出日志」**（`DuelView.buildAiLogReport()` → `ai-log-<卡组>-<时间>.md`）：除了每条 trace 的完整请求 / 返回，还打包了模型配置（密钥省略）、skill 是否加载、录像解析状态、当前盘面与累计用量——排查「为什么没照录像打」光看 trace 是看不出 skill 有没有生效的。日志裁剪（`AI_LOG_MAX`）优先保留 `plan` / `replan` / `interrupt`，否则一整局的流水会把开局的规划挤掉。

### 启动率（`views/RatesView.vue`、`lib/rates.ts`、`ratesWorker.ts`、`lib/ratesPoster.ts`）

- **进页面不自动算**：求解只由「开始计算」按钮或「导出图片」触发，`onMounted` 与换卡组 watch 只做 `seedFromStarters()` / `resetWorker()`。这是用户明确要求过的行为，别加回自动计算。
- `compute()` 返回 `Promise<void>`，靠 `computeWaiters` 在 `settle()`（成功 / 失败）和 `resetWorker()`（任务被掐掉）时 resolve；导出图前 `await compute()` 才拿得到抽滤 pp。**新增任何提前结束求解的路径都要 `flushComputeWaiters()`**，否则导出会永久挂起。
- `stale` 只看 `handSize / starters / blockers / effects`（watch 里手写 JSON 快照，不是整份 plan）。废件 / 手坑张数存在 `RatePlan.brickCount` / `handtrapCount`（`?: number`，旧档由 `normalizePlan` 补 0），写入走 `deck.patchPlan` 而不是 `mutate()`——**别把它们塞进 stale 判定**，否则手填一个数字就把已算结果标成过期。
- `clauseChances` 是每个启动组单独调 `openingChance(buildRateModel(deck, [clause], blockers), …)` 的静态解析解（不含抽滤），和 `result.steps` 不是一回事：`steps[0]` 是起手，`steps[k]` 对应第 k 个抽滤效果的新增，导出图的 pp 取的是后者。
- 底部「废件上手率 / 手坑上手率」共用 `useHandTable()`（超几何）：**条形表是「恰好 k 张」、互不累计**，「至少 1 张」单独放面板右上角。这两个口径用户已经误读过一次（18 张的「恰好 1 张」比 10 张低是正常的），改文案别把「恰好」省掉。
- 「导出图片」→ `renderRatesPoster()`（纯 canvas，不加载卡图，因此没有跨域污染画布的问题）：顶部卡组名 + 先手 / 后手，之后依次①启动组（按组内卡张数降序）②抽滤组件与 `+X.XXpp` ③废件 ④手坑，③④没填就不画。生成后进预览弹窗（复用 `.overlay.center` / `.poster-modal` / `.poster-preview`），由 `downloadPoster()` / `copyPoster()`（`lib/clipboard.ts`）落地，`closePoster()` 与 `onUnmounted` 负责 revoke objectURL。

### 全站数据备份（`src/lib/siteData.ts`）

「使用说明」页底部的导出 / 导入。**白名单**：`LOCAL_KEYS`（卡组 v2、手坑、自定义卡、skill 包、暂存、主题、AI 配置）+ IndexedDB `ygo-skill` 的 `replays` 表。

- **排除项**：`ygo-ai-config` 里的 `apiKey`（导出前清空，导入时若备份为空则保留本机已有的 Key，避免恢复备份把密钥清掉）；`ygo-infer` 卡库缓存（十几 MB 且可重新下载）。
- 录像的 `bytes` 是 `Uint8Array`，JSON 化会变成数字下标对象，所以走 `BIN_TAG` 标记 + base64 编解码（分块 `String.fromCharCode`，避免大数组爆栈）。
- 导入是**覆盖式**：localStorage 按 key 覆盖（备份里没有的 key 不删），每个库的每张表 `clear()` 后重写；表/库不存在时按备份里的 `keyPath` / index 元数据补建，换浏览器也能恢复。导入成功后页面 reload，内存里的 store 重新读盘。
- 备份结构版本 `SITE_BACKUP_VERSION`，改字段就 +1；导入时版本过新直接拒绝，不做半程写入。

### 视图与组件

- `views/HomeView.vue`：宣传页 + 一行状态数字（卡池张数 / 手坑定义数 / 录像路线来源）。
- `views/CardsView.vue`：检索列表 + 详情抽屉（外链 ygocdb）。
- `views/DeckView.vue`：卡组构建 / 导入导出 / 竖版长图。
- `views/DuelView.vue`：真实对局界面（`components/duel/DuelQuestionPanel.vue` 负责选项 / 选卡交互），打完可以「绑定到卡组」变成录像样本；结束弹窗里可以给这局起名（`replayNameInput`，默认「卡组名 · 第 N 回合 · 时间」），导出 .yrp 的文件名也用它。页内的「AI 设置」是 `RouterLink` 到 `/ai`（**会离开当前对局**，按钮 title 里提示先暂存）；AI 未开启时「AI 代打」按钮置灰。
- `views/RatesView.vue`：启动率计算（`lib/rates.ts` + `ratesWorker.ts`）+ 底部废件 / 手坑查询表 + 长图导出（`lib/ratesPoster.ts`，弹窗里下载 / 复制）；细节见上文「启动率」。
- `views/AiSettingsView.vue`：AI 设置 tab（`/ai`）。总开关 / 协议 / 端点 / 密钥 / 模型 + 参数组（默认即推荐值，可「恢复推荐参数」），自动保存；见上文「AI 设置」。
- `views/GuideView.vue`：使用说明 tab（`/guide`）。快速上手（卡组 → 录像 → 分析 → skill 包）、功能导航表、AI 开启步骤、数据与备份、常见问题。文案跟着功能改，别让它变成过期教程。
- `views/SkillsView.vue`：录像列表（导入 / 单份导出 `.yrp` / 展开链图 / 移除）、重新解析、检索图、Skill 包预览 / 导出。单份导出直接写 `loadReplayBinding()` 拿到的原始字节，和当初导入的文件一致。「展开图」把解析结果画成竖版长图（`lib/replayPoster.ts`，canvas + 同源卡图），弹窗里可下载 / 复制。「检索图」汇总当前卡组**全部录像**的 `flows`，画成卡组卡片围成一圈、连线按区域转移类型上色的圆图（`lib/flowPoster.ts`）；缺 `flows` 的旧缓存会在点按钮时按需重放（`loadReplayFlows()`）。**每份录像行也有「检索图」**，同一套绘制只看这一条展开的关系，弹窗标题区分「卡组维度 / 单份录像」，导出文件名用卡组名或录像名。图里**只画参与过连线的卡**（没连线的卡会把环撑大），环半径随节点数伸缩，被省略的张数写在页脚。弹窗里是一张**活的 canvas**（`prepareFlowPoster()` 返回 `FlowPosterScene`，卡图只预加载一次）：点某张卡就 `render(卡名)` 只留这张卡与有直接连线的卡、其余压暗，再点同一张（或点空白）恢复全图；`cardAt()` 用归一化坐标做命中测试，所以 CSS 缩放后点击依然准。中心**不画统计徽章**（会盖住穿心的连线），份数 / 连线数 / 参与张数只在标题下方那行副标题里。「手坑报告」（`lib/handtrapReport.ts`）分两个**互不混合**的入口：右上角按钮是卡组维度（全部录像按手坑汇总「命中步数 / 占总步数 / 命中录像数 / 最早第几步 / 被自排连锁规避次数」）；单份维度在每份录像的「手坑报告」按钮上（这条展开共几步、哪几步会吃手坑、每个手坑占本展开的比例）。同一份录像里同一手坑命中同一步只算一步；`row.hitSteps` 是**跨手坑去重**的「不安全步数」（同一步可能同时吃两种手坑）。规则升过版的录像（`analysisVersion` 对不上）两处都不计入，卡组维度顶部会写「另有 N 份已过期未计入」；两个弹窗都能导出各自的 Markdown。单份报告还有第二块「抽卡型手坑」（`lib/duel/drawHandtraps.ts`，只存在于单份维度）：它与上面的打断型手坑分开统计，按回合给出「若对手在这一刻丢增殖的 G / 欢聚友伴，这回合还能抽几张」。数据只看事件流里的 `move`——我方把怪兽放进怪兽区且 `reason` 含 `SUMMON` / `SPSUMMON`（被无效的特召不产生这条移动），来源区域决定算哪张欢聚友伴：手卡 → 噗露莉娅（含通常召唤）、卡组 / 额外 → 浮华洛丝、墓地 / 除外 → 喵露丝；增殖的 G 算所有特召。抽数直接取该回合这类动作的次数（按上限算，不扣首次）。三张欢聚友伴同一回合只能发一张，所以分别列出来而不是相加。录像行还有「改名」（`renameReplayBinding()`，回车保存 / Esc 取消 / 失焦提交）。报告**不统计尼比鲁与锁鸟**（`REPORT_SKIP`）：前者是「累计第 5 次召唤」的固定计数，后者只在第一次检索后生效，报出来的步数基本等于召唤 / 检索次数，读不出检索链的信息；判定本身不变，录像列表与 skill 包照旧包含这两个手坑点。Skill 包面板的「AI 生成 skill 包」需要 AI 开关打开（否则置灰），生成结果按卡组落盘、不会因为切页消失；每个文件可编辑保存，也可新增，再次点生成才覆盖。
- 全局样式集中在 `src/style.css`；主题通过 `document.documentElement.dataset.theme`（`dark` / `light`，默认 dark）切换。

> 工坊留下的一批组件（`TimingTimeline` / `TimingEditor` / `ChainEditor` / `MoveRows` / `ResistancePanel` / `DeckSidebar` / `ComboCards` / `CardPicker` / `HandtrapEditor` / `DuelPlayback` / `DuelBoard` / `DuelField`）和各视图里的入口都已删除；`src/style.css` 里仍留有部分未引用的旧样式，清理时按类名逐个确认（动态拼接的类名不能靠 grep 判定）。

## 已知文档偏差

`README.md` 与本文档都按「录像即路线」的现状描述。历史上曾经存在手工编排模型（`lib/engine.ts` → `lib/timeline.ts`、检查点、备线 / Plan B），这些都已彻底删除，文档里不应再出现。改架构时**同时**更新 README 与本文件，避免再次漂移。

## 许可证

AGPL-3.0-only（全文见 `LICENSE`，`package.json` 里 `"license": "AGPL-3.0-only"`）。修改后通过网络提供服务时，同样需要按 AGPL-3.0 提供对应源码。
