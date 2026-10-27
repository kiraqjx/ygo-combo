# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

## 常用命令

- `npm install` — 安装依赖（Vue 3 / Vite / Pinia / Vue Router / fflate / gifenc）。
- `npm run dev` — 开发服务器，固定端口 5173；`/pics/*` 由 Vite 代理到 `cdn.233.momobako.com/ygopro/pics`，用于卡图同源（canvas 可读像素，GIF 导出依赖这一点）。
- `npm run typecheck` — `vue-tsc --noEmit`，本仓库唯一可用的静态检查；提交前跑这个。
- `npm run build` — `vue-tsc -b && vite build`，产物在 `dist/`；纯静态站点，History 路由需服务端回退到 `index.html`。
- `npm run preview` — 预览构建产物（同样带 `/pics` 代理）。
- 仓库没有配置 lint 与测试框架（无 Vitest / ESLint 脚本），也没有单测可跑。新增测试前需先引入 runner 并补充 npm script。

## 架构概览

纯前端、无后端。数据只有两条持久化通道：IndexedDB（卡库缓存）与 localStorage（展开、手坑配置、主题）。

### 领域模型（`src/types.ts`）

一个 `Combo` = 起手 `opening` + 卡组 `deck` + 有序的 `timings`。`Timing` 不是"事件标签"，而是一个时点上的完整结算过程，由四段 `CardMove[]` 组成并严格按序推演：

`setup`（发动时置入魔陷区，规则必发生）→ `cost`（必成功、不吃手坑）→ `effect`（可被手坑无效/封锁）→ `settle`（结算后送墓等，必发生）。`chains` 是 C2..Cn 的 `ChainEntry`，结构同上。

`CardMove` 的 `phase`（`cost` / `effect` / `auto`）、`handtraps`（该段可被哪些手坑阻止）、`unknown`（未知卡片，不参与按卡名连链）、`auto`（由规则自动生成）决定了整个推演语义。`Timing.manualLinks` / `ManualLink` 是自动连链失效时的兜底：手动声明"本步用到的卡来自上游某步的某次移动"。

**约定：任何对 `Combo` 的修改都走 `stores/combos.ts` 的 action**（`addTiming` / `updateTiming` / `saveChain` / `patchCurrent` …），它们负责 `touch()` 更新时间戳；组件直接改 `combo` 字段会绕过持久化语义。

### 推演内核（`src/lib/timeline.ts`）

全项目最需要先读懂的文件：

1. `initialLedger()` 用卡组 + 起手构建区域账本（`Record<ZoneId, Map<卡名, 数量>>`），未录满的手牌按 `UNKNOWN_CARD` 补足。
2. `run(combo, { cancels, baseline, trackLinks })` 逐时序推进：先判断上游链是否断裂 → 记录状态（`ok` / `broken` / `negated` / `partial`）→ 按 setup / cost / 连锁发动 / effect / 连锁结算 / settle 依次落账，产出 `TimingState[]`、`TimingLink[]` 与逐动作 `PlaybackFrame[]`。
3. `buildCancels()` 把「某时序 + 某手坑」翻译成被取消的移动集合：`category: 'negate'` 的整段无效该时序全部 `effect` 移动，`lock` / `zone` 类只取消被打标记的那几段。
4. `analyzeTimeline()` 先跑基准（无手坑），再跑带 `cancels` 的版本，用基准链路 + `resolveManualLinks()` 计算出最终 `links`，并把"产出段被取消 / 任一端断链"的链路标 `broken`。
5. `handtrapReports()` 对每个手坑的每个可命中时点各模拟一次，取对展开最不利的结果（最早断线、断线最多）作为 `deadAt` / `verdict` / `headline`。

推演近似规则（改动内核时不要破坏）：cost 与 setup/settle 永不被手坑取消；从 `deck` / `extra` 取牌不校验余量，其他区域不足只记 reason 不中断；同名卡必须来自同一区域才连链；资源链断裂会向下游传播。

### 手坑注册表（`src/lib/handtraps.ts` + `stores/handtraps.ts`）

`BUILTIN_HANDTRAPS` 是初始值，用户配置存 localStorage。store 每次 `commit()` 调用 `syncHandtrapRegistry()` 把自定义手坑写入模块级 `HANDTRAPS` / `HANDTRAP_MAP`，因此内核函数无需接收手坑列表。代价是：**手坑变了必须让上层重新计算**，`store.version` 计数器专门用于在 `computed` 中建立依赖（见 `LabView` 的 `analysis`）。

### 卡库与检索（`src/lib/cardDb.ts`、`src/lib/search.ts`、`stores/cards.ts`）

`loadCardDatabase()` 下载 ygocdb 的 `cards.zip` → fflate 解压 → `normalizeCard()` 归一化成 `CardData`（含小写检索串 `blob`、`frame`、`kinds`）→ JSON 缓存进 IndexedDB（`ygo-infer` DB）。卡库不可用时 `remoteSearch()` 回退到 ygocdb 在线接口。`searchCards()` / `collectFacets()` 在内存里做筛选与聚合，`App.vue` 挂载时触发 `cardStore.init()`。

### 文本推断（`src/lib/infer.ts`）

用正则从效果文本里识别"卡组加手 / 卡组特召 / 卡组送墓 / 墓地取牌 / 抽卡 / 丢弃自身"等事件，产出 `inferTiming()` / `makeTiming()`（卡牌 → 时序草稿）；`autoRuleMoves()` 依据卡种生成 `auto: true` 的 setup/settle 规则移动；`suggestHandtraps()` / `suggestTargets()` 给编辑器提供默认标记与卡组目标建议；`reuseAutoIds()` 在编辑器改动后复用旧的自动移动 id，避免手动连线失效。这里全是启发式规则，只在"选择卡片时"提供默认值，不参与推演。

### 视图与组件

- `views/HomeView.vue`：宣传页 + 用 `analyzeCombo(createSampleCombo())` 实时展示示例结论。
- `views/CardsView.vue`：检索列表 + 详情抽屉，可把卡直接转成时序、卡组或起手。
- `views/LabView.vue`：工作坊编排层。持有 `interrupts`（当前应用的手坑注入点）、`selectedTimingId`、各类弹窗状态，把 `analysis` 分发给 `TimingTimeline`（流程与断链高亮）、`TimingEditor` / `ChainEditor` / `MoveRows`（段与移动编辑）、`ResistancePanel`（手坑报告、注入点选择）、`DeckSidebar`（卡组 / 起手）、`DuelPlayback`（动画演示）。
- `components/DuelPlayback.vue` → `DuelBoard.vue` / `DuelField.vue`：按 `PlaybackFrame[]` 逐帧播放；`lib/boardCanvas.ts` 是纯 canvas 布局与绘制（`layoutBoard` / `drawBoardFrame`），`lib/exportGif.ts` 用 gifenc 编码导出 GIF——卡图必须走同源 `/pics/`（`cardImageProxyUrl`），否则 canvas 被污染、导出失败。
- 全局样式集中在 `src/style.css`；主题通过 `document.documentElement.dataset.theme`（`dark` / `light`，默认 dark）切换。

### 内置示例数据

`src/data/sampleCombo.ts` 是唯一内置示例：内容为真实导出的 combo JSON，`createSampleCombo()` 每次返回深拷贝，避免编辑污染源数据；`stores/combos.ts` 在无本地数据、删空、点「示例」时都用它。`src/data/demoCombo.ts` 是早期手写的两只示例（英雄假面 / 混沌），已无引用，属于遗留代码——不要把它当作新的示例来源。

## 已知文档偏差

`README.md` 的功能描述停留在旧模型（提到 `lib/engine.ts`、"检查点"、"备线 / Plan B"），这些概念在当前代码中已不存在（内核是 `lib/timeline.ts`，备线由手坑注入点 `Interrupt` + 链路破坏替代）。以代码为准；改架构时顺手修正 README。
