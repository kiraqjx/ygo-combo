# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

## 常用命令

- `npm install` — 安装依赖（Vue 3 / Vite / Pinia / Vue Router / fflate / ocgcore-wasm）。
- `npm run dev` — 开发服务器，固定端口 5173；`/pics/*` 由 Vite 代理到 `cdn.233.momobako.com/ygopro/pics`，用于卡图同源（canvas 可读像素，GIF 导出依赖这一点）；`/api/llm/*` 代理到 `api.deepseek.com`（AI 代打用，目标可用 `VITE_LLM_PROXY_TARGET` 覆盖）。
- `npm run typecheck` — `vue-tsc --noEmit`，本仓库唯一可用的静态检查；提交前跑这个。
- `npm run build` — `vue-tsc -b && vite build`，产物在 `dist/`；纯静态站点，History 路由需服务端回退到 `index.html`。
- `npm run preview` — 预览构建产物（同样带 `/pics` 代理）。
- `npm run assets:duel` — 跑 `scripts/fetch-duel-assets.mjs` 拉取对局资源到 `duel-assets/`（ocgcore 官方 Lua 脚本、卡名 / 效果描述）。仓库里已经有一份，除非内核升级导致脚本对不上才需要重跑。
- 仓库没有配置 lint 与测试框架（无 Vitest / ESLint 脚本），也没有单测可跑。新增测试前需先引入 runner 并补充 npm script。

## 架构概览

纯前端、无后端。持久化通道：IndexedDB（卡库缓存 `ygo-infer`、录像与解析结果 `ygo-skill`）与 localStorage（手坑配置、卡组、自定义卡、主题）。许可证是 AGPL-3.0-only（见根目录 `LICENSE`）。

### 领域模型（`src/types.ts`）

只剩三件事：`CardData`（卡库归一化结果）、`DeckEntry`（卡号 + 卡名 + 张数）、以及录像侧的 `ReplayAnalysis`（见 `lib/duel/replay.ts`）。

combo 工坊（`Combo` / `ComboLine` / `Timing` / `CardMove` 那套手工编排模型）已经整体删除：现在「展开路线」就是一份绑定到卡组的 `.yrp` 录像。**不要再往这里加回手工模型**，否则又会分叉出两套路线语义。

### 手坑定义（`src/lib/handtraps.ts` + `stores/handtraps.ts`）

`BUILTIN_HANDTRAPS` 是内置手坑（卡号 + 类别 + 配色），用户配置存 localStorage。起手样本（`skillSamples.ts`）与 skill 包的「手牌角色 / 手坑起手」会用到它；**手坑变了要让上层重新计算**，`store.version` 计数器就是给 `computed` 建依赖用的。

注意：这里的 `category` / `counting` 只是起手统计用的分类，与「录像手坑判定」（`lib/duel/replayHandtraps.ts`）是两套规则，互不共享配置。模块级 `HANDTRAPS` / `HANDTRAP_MAP` 注册表已随推演内核一起删除。

### 卡库与检索（`src/lib/cardDb.ts`、`src/lib/search.ts`、`stores/cards.ts`）

`loadCardDatabase()` 下载 ygocdb 的 `cards.zip` → fflate 解压 → `normalizeCard()` 归一化成 `CardData`（含小写检索串 `blob`、`frame`、`kinds`）→ JSON 缓存进 IndexedDB（`ygo-infer` DB）。卡库不可用时 `remoteSearch()` 回退到 ygocdb 在线接口。`searchCards()` / `collectFacets()` 在内存里做筛选与聚合，`App.vue` 挂载时触发 `cardStore.init()`。

卡库只有正式服数据，先行服 / 新卡搜不到，因此 `lib/customCards.ts` 支持手动录入（只写卡名、种类、可选卡号与效果文本），存 localStorage，并由 `stores/cards.ts` 与下载卡库合并成 `store.cards`（`library` 是下载库，`custom` 是本地库），检索、卡组、启动率都走合并后的列表。自定义卡没有卡图，`App.vue` 用捕获阶段的全局 `error` 监听把失败的 `<img>` 换成 `CARD_PLACEHOLDER`。

### 文本推断（`src/lib/infer.ts`）

只剩启动率要用的部分：`pickEffectSegment()` 从多段效果（①②③）里挑要建模的那一段（优先墓地 / 丢弃触发段），`inferRateOps()` 抽出抽滤算子——看牌库顶 N 张 / 其中拿 M 张 / 其余送墓或除外，抽 N 张，丢 N 张手卡。原来的「卡片 → 时序草稿」推断（`inferTiming` / `autoRuleMoves` / `suggestHandtraps` / `suggestTargets` / `reuseAutoIds`）已随工坊删除。

### 真实对局引擎（`src/lib/duel/*`）

用 `ocgcore-wasm`（优先 JSPI 异步版，`!wasm?url` 加载，不支持时退回同步版）真正跑 OCG 规则。`duel-assets/` 是它需要的本地资源：`scripts/official/*.lua`（卡片脚本）、`descriptions.json`、`strings`，由 `session.ts` 通过 `ScriptStore` / `loadDuelStrings()` 喂给内核。

- `session.ts`（`DuelSession`）—— 对象生命周期的唯一入口：`start()` / `waitForEnd()` / `snapshot()`；内部循环 `process()` → 处理消息 → `takeQuestion()` → 取答复。三种答复来源：界面（`waitAnswer`）、沙包 AI（`autoRespond`）、录像回放（`rawQueue` 直接把 `.yrp` 里的响应字节按序喂回）。同时产出三样东西：`state`（界面状态）、`logs`（人类可读日志）、**`signals`（结构化事件流）**。
- `signals` 是录像手坑分析的**唯一数据源**。`DuelSignalKind` 见 `types.ts`：`summon` / `spsummon` / `flip`（召唤宣言）、`summoned` / `spsummoned` / `flipsummoned`（内核确认成功，被无效就没有这条）、`set`、`position`（表示形式变化）、`chain`（发动）、`solving` / `solved` / `negated`（连锁结算）、`move`（带 from/to 区域位与 reason 位）、`draw`、**`prompt`（SELECT_CHAIN 提问，表示此刻轮到谁决定要不要连锁）**。新增 kind 时要同步检查 `replayHandtraps.ts` 的 switch。
- `replay.ts`（`analyzeReplay(bytes, resolveName)`）—— `.yrp` → `ReplayAnalysis`：`steps` / `decisions` / `handtrapHits` / `analysisVersion` / `incomplete`。解析是确定性的（同种子 + 同响应序列 → 同结果），所以结果会被缓存。
- `replayHandtraps.ts`（`analyzeHandtrapHits(signals)`）—— 从事件流反推「假设对手手上有这些卡，能在第几步打断」。规则细节见下一节。
- `replayStore.ts` —— IndexedDB（`ygo-skill` / `replays`）存 `.yrp` 原始字节 + 解析结果，卡组删除后录像不自动清理（保留 `deckName` 供孤儿清理）。
- 其他：`yrp.ts`（解析录像头 / 卡组 / 随机种子）、`checkpoint.ts`（暂存恢复）、`interaction.ts` + `response.ts`（提问 → 候选 / 响应字节）、`auto.ts`（沙包策略）、`random.ts`（xoshiro256** 洗牌）、`labels.ts`（选项文案）、`cards.ts`（卡组 → 内核卡数据）。

**约定：`DuelSignal` 只增不改语义**。改动信号结构或 kind 时要同时梳理 `replayHandtraps.ts` 与任何对 `signal.kind` 做 switch 的地方（目前只有它一个消费者）。

### 录像手坑判定（`src/lib/duel/replayHandtraps.ts`）

当前只支持 7 张：灰流丽、灵王的波动、无限泡影、屋敷童、幽鬼兔、锁鸟、原始生命态 尼比鲁。抽卡型手坑（增殖的G / 欢聚友伴系列）故意不体现。只报前 20 步（`MAX_STEP`）。

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
- 模型地址默认 `/api/llm`：浏览器直连 `api.deepseek.com` 没有 CORS 头。Vite 在 `server.proxy` / `preview.proxy` 转发，生产要在反代上配同样的 location，目标地址可用 `VITE_LLM_PROXY_TARGET` 覆盖。
- 配置存 localStorage（`ygo-ai-config`），不进 skill 包、不写对局记录。`AgentRunner` 持有 `liveAiConfig` 引用，设置改动即时生效。
- **skill 输入必须带当前卡组的录像**（`DuelView` 的 `skillBindings` / `loadSkillBindings()`）：录像就是路线来源，`skillCache` 的 key 里含录像 id 列表，换录像要重算。之前这里传空数组，模型永远看不到录过的打法。
- **单步决策的候选会带上录像步骤标注**：`pickReplayRoute()` 用「手卡 + 墓地 + 当前连锁」当焦点挑一条录像，`alignReplaySteps()` 按「动作词 + 卡名」把候选对到 `〔录像第 N 步：…〕`（`不发动` / `取消` / `结束回合` 这类负面候选不参与，否则「不发动」会被当成「发动」）。`option`（效果分支）提问还必须在标题里点名「正在处理『某卡』的效果」，因为内核只给「伤害改变 / 盖放魔陷」这种脱离卡名的分支名，模型单看候选无法和录像对上。
- **`AgentTrace` 是对外的决策日志**：每条带 `kind`（`plan` / `replan` / `decide` / `auto` / `fallback` / `interrupt`）、`title`、`detail`、模型给的 `reason`、候选数、耗时与 token 增量（`mark()` / `since()` 算差值）。`DuelView` 把它渲染成右侧日志抽屉，`auto` 类（唯一候选、只能全选）默认折叠。加新的决策分支时记得补一条 trace，否则界面上会「跳步」。**日志抽屉支持「导出日志」**（`DuelView.buildAiLogReport()` → `ai-log-<卡组>-<时间>.md`）：除了每条 trace 的完整请求 / 返回，还打包了模型配置（密钥省略）、skill 是否加载、录像解析状态、当前盘面与累计用量——排查「为什么没照录像打」光看 trace 是看不出 skill 有没有生效的。日志裁剪（`AI_LOG_MAX`）优先保留 `plan` / `replan` / `interrupt`，否则一整局的流水会把开局的规划挤掉。

### 视图与组件

- `views/HomeView.vue`：宣传页 + 一行状态数字（卡池张数 / 手坑定义数 / 录像路线来源）。
- `views/CardsView.vue`：检索列表 + 详情抽屉（外链 ygocdb）。
- `views/DeckView.vue`：卡组构建 / 导入导出 / 竖版长图。
- `views/DuelView.vue`：真实对局界面（`components/duel/DuelQuestionPanel.vue` 负责选项 / 选卡交互），打完可以「绑定到卡组」变成录像样本。
- `views/RatesView.vue`：起手 / 启动率计算（`lib/rates.ts` + `ratesWorker.ts`）。
- `views/SkillsView.vue`：录像列表（导入 / 单份导出 `.yrp` / 移除）、重新解析、Skill 包预览 / 导出。单份导出直接写 `loadReplayBinding()` 拿到的原始字节，和当初导入的文件一致。
- 全局样式集中在 `src/style.css`；主题通过 `document.documentElement.dataset.theme`（`dark` / `light`，默认 dark）切换。

> 工坊留下的一批组件（`TimingTimeline` / `TimingEditor` / `ChainEditor` / `MoveRows` / `ResistancePanel` / `DeckSidebar` / `ComboCards` / `CardPicker` / `HandtrapEditor` / `DuelPlayback` / `DuelBoard` / `DuelField`）和各视图里的入口都已删除；`src/style.css` 里仍留有部分未引用的旧样式，清理时按类名逐个确认（动态拼接的类名不能靠 grep 判定）。

## 已知文档偏差

`README.md` 与本文档都按「录像即路线」的现状描述。历史上曾经存在手工编排模型（`lib/engine.ts` → `lib/timeline.ts`、检查点、备线 / Plan B），这些都已彻底删除，文档里不应再出现。改架构时**同时**更新 README 与本文件，避免再次漂移。

## 许可证

AGPL-3.0-only（全文见 `LICENSE`，`package.json` 里 `"license": "AGPL-3.0-only"`）。修改后通过网络提供服务时，同样需要按 AGPL-3.0 提供对应源码。
