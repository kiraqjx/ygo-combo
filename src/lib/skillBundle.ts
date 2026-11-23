import type { CardData, DeckEntry } from '@/types'
import { HANDTRAP_FOOTNOTE, hitConsequenceText, hitNameText, hitPositionText } from './duel/replayHandtraps'
import type { ReplayAnalysis, ReplayStep } from './duel/replay'
import { buildRateModel, openingChance, slotLabel, type RateClause } from './rates'
import { buildSkillCoverage, type CoverageItem, type SkillInput } from './skill'
import { buildSampleReport, listStarterClauses, type SampleReport } from './skillSamples'

/**
 * 分片 skill 包（给 AI 的运行时形态）。
 *
 * 目标：AI 拿到 5 张起手后先只读路由层（2~4 KB），判断
 * 「哪些是启动点 / 手坑 / 废件」，再按路由表加载一条录像路线（3~8 KB），
 * 需要时才去看单卡完整文本。相比整份大文档，上下文短一个数量级。
 *
 * 路线唯一来源是录像（combo 工坊已废弃）：每份绑定到该卡组的 .yrp 一个分片，
 * 按「起手是否包含启动条件的全部卡」挂到对应启动点。
 *
 * 产物结构（zip 内）：
 *   <卡组>-skill/manifest.json   机器可读：启动点、手坑、废件、卡号角色
 *   <卡组>-skill/00-router.md    手牌判断 + 路由规则 + 覆盖度
 *   <卡组>-skill/20-replay-XX.md 每份录像一条：起手、展开流程、手坑命中点
 *   <卡组>-skill/90-fallback.md  无启动点 / 无录像的兜底
 *   <卡组>-skill/cards/<code>.md 被路线引用到的卡（完整效果文本）
 */

export interface BundleStarter {
  code: string
  label: string
  requires: { code: number; name: string }[]
  /** 启动条件里的「不能上手」卡：起手有的话这条路线不成立（旧存档没有这个字段） */
  avoid?: { code: number; name: string }[]
  /** 先攻起手命中概率 */
  chance: number
  /** 后攻（多抽 1 张）命中概率 */
  secondChance: number
  /** 路线文件：起手命中这套启动条件的录像（`20-replay-*.md`）；null 表示还没有录像用这张卡启动 */
  file: string | null
  /** 命中这条启动点的录像 */
  replays: { code: string; name: string }[]
}

export interface BundleReplay {
  code: string
  file: string
  name: string
  turns: number
  incomplete: boolean
  /** 对手真能打到的手坑命中点数量 */
  hits: number
  /** 被自排连锁规避、实际打不到的命中点数量 */
  dodged: number
  /** 起手卡名（用于按当前手牌匹配「这条起手该怎么打」） */
  opening: string[]
  /** 我方前若干步操作（phase：text），给单步决策当路线参考 */
  steps: string[]
  /**
   * 录像里每次「效果分支」提问实际选了哪个选项（去重）。
   *
   * 这类候选只有「从卡组仪式召唤 / 从手卡仪式召唤」这种通用名字，模型得自己
   * 对照手卡才能判断，日志里就出现过手卡明明有「天羽羽斩之巳剑」却选了「从卡组」
   * ——那一步选错，后面 No.90 的素材就不够了。直接把录像的选择标在候选上。
   */
  options: string[]
  /**
   * 录像里「选择卡片」时实际选中过的卡名（去重）。
   *
   * 有些 combo 的关键就在这张卡的归属上——录像是「两颗心灵检索混沌恶魔、
   * 然后把混沌恶魔自己丢掉」，才能在墓地发动它的效果；模型只看到「丢弃 1 张手卡」，
   * 规划时就写成了「丢弃效果遮蒙者」，链路当场断掉。
   */
  picks: string[]
}

export interface BundleManifest {
  schemaVersion: number
  deck: { name: string; main: number; extra: number; side: number }
  generatedAt: string
  files: {
    router: string
    fallback: string
    replays: string[]
    cards: string
  }
  starters: BundleStarter[]
  replays: BundleReplay[]
  handtraps: { code: number; name: string; category: string }[]
  bricks: {
    cards: { code: number; name: string }[]
    allowance: number
    clear: string
    /** 与其中任意一张同时上手时，这条废件不生效（旧存档没有这个字段） */
    exempt?: string[]
  }[]
  /** 卡号 → 角色（启动点 code / handtrap / brick / flex） */
  roles: Record<string, string[]>
  coverage: CoverageItem[]
}

export interface SkillBundle {
  /** 相对 zip 根目录的文件路径 → 文本内容 */
  files: Record<string, string>
  manifest: BundleManifest
  zipName: string
  dir: string
}

const MAX_CARD_TEXT = 1600
const CARD_DIR = 'cards'
/**
 * 给单步决策的路线最多留多少步。
 *
 * 过滤噪声后一份完整 T1 展开 50 多步：截到 36 会把「超量 No.90 → 黑魔女 → 罪宝」
 * 整段砍掉，规划时模型只看到前半段，后面自然写不出步骤。
 */
const REPLAY_STEPS_MAX = 60

/**
 * 只说明「连锁怎么结算的」的系统行，对「照着打」没有信息量。
 * 一份展开里这类行能占一半以上，留着会把真正的操作挤出 prompt。
 */
const STEP_NOISE = [/^C\d+\s*结算$/, /^连锁结束$/, /^结算$/]

function actionableSteps(steps: ReplayStep[]): ReplayStep[] {
  return steps.filter((step) => {
    const text = step.text.trim()
    return !STEP_NOISE.some((pattern) => pattern.test(text))
  })
}

/** 启动条件的人话：必需卡 + 「不带 X / 最多 N 张 / 合计 N 张」 */
function clauseLabel(clause: RateClause): string {
  return clause.slots.map(slotLabel).filter(Boolean).join(' + ')
}

/** 一手具体的起手牌是否满足这条启动组（多卡检查按合计张数算） */
function clauseMatchesOpening(clause: RateClause, opening: number[]): boolean {
  const counts = new Map<number, number>()
  for (const id of opening) counts.set(id, (counts.get(id) ?? 0) + 1)
  return clause.slots.every((slot) => {
    let sum = 0
    for (const card of slot.cards) sum += counts.get(card.id) ?? 0
    return sum >= slot.min && (slot.max === null || sum <= slot.max)
  })
}

export function buildSkillBundle(input: SkillInput): SkillBundle {
  const nameOf = input.nameOf
  const entries = [...input.main, ...input.extra, ...input.side]
  const dir = bundleDir(input.deckName)
  const samples = buildSampleReport({
    main: input.main,
    plan: input.plan,
    starterGroups: input.starterGroups,
    handtraps: input.handtraps,
    nameOf,
  })
  const clauses = listStarterClauses({ plan: input.plan, starterGroups: input.starterGroups, nameOf })

  const coverage = buildSkillCoverage(input, samples)

  const handtrapDefs = (input.handtraps ?? []).filter(
    (def) => def.cardId && input.main.some((entry) => entry.id === def.cardId && entry.count > 0),
  )
  const handtrapIds = new Set(handtrapDefs.map((def) => def.cardId as number))
  const blockers = input.plan?.blockers ?? []
  const brickIds = new Set(blockers.flatMap((blocker) => blocker.cards.map((card) => card.id)))

  // 录像：每份可解析的 .yrp 一个文件，含展开流程与手坑命中点
  const replays: BundleReplay[] = []
  const replayFiles: Record<string, string> = {}
  /**
   * 录像 → 启动点的关联依据。
   *
   * 工作坊已经废弃，combo 现在就是「录一局」。所以判定某条启动点有没有路线，
   * 看的是录像起手里有没有这套启动条件的全部卡：单卡动点只要起手有那张就算，
   * 两卡 combo 要求起手同时有这两张。
   */
  const replaySources: { code: string; file: string; name: string; opening: number[] }[] = []
  input.bindings.forEach((binding, index) => {
    const analysis = binding.analysis
    if (!analysis?.ok) return
    const code = `replay-${String(index + 1).padStart(2, '0')}`
    const file = `20-${code}.md`
    const allHits = analysis.handtrapHits ?? []
    replays.push({
      code,
      file,
      name: binding.name,
      turns: analysis.turns,
      incomplete: analysis.incomplete,
      hits: allHits.filter((hit) => !hit.dodged).length,
      dodged: allHits.filter((hit) => hit.dodged).length,
      opening: (analysis.openingHand ?? []).map((id) => nameOf(id) || `#${id}`),
      /**
       * 给单步决策看的路线：只取我方动作，并滤掉「C1 结算 / 连锁结束」这类系统行。
       *
       * 之前直接 `slice(0, 10)` 整段日志，一份正常展开的前 10 行有一半是连锁结算，
       * 主要阶段的巳剑展开根本进不了 prompt——模型只能看到抽卡阶段那几步，
       * 于是「复现整条展开」无从谈起。
       */
      steps: actionableSteps(analysis.steps.filter((step) => step.player === 0))
        .slice(0, REPLAY_STEPS_MAX)
        .map((step) => `${step.phase}：${step.text}`),
      options: [
        ...new Set(
          (analysis.decisions ?? [])
            .filter((decision) => decision.kind === 'option')
            .map((decision) => /「([^」]+)」/.exec(decision.text)?.[1] ?? '')
            .filter(Boolean),
        ),
      ].slice(0, 24),
      picks: [
        ...new Set(
          (analysis.decisions ?? [])
            .filter((decision) => decision.kind === 'card')
            .map((decision) => /「([^」]+)」/.exec(decision.text)?.[1] ?? '')
            .filter(Boolean),
        ),
      ].slice(0, 40),
    })
    replaySources.push({
      code,
      file,
      name: binding.name,
      opening: (analysis.openingHand ?? []).slice(),
    })
    replayFiles[file] = replayMarkdown(input, binding.name, analysis, code)
  })

  // 命中概率与路由层的「无启动点」口径一致：都扣掉废件超限的情况
  const model = buildRateModel(input.main, clauses, blockers)
  const starters: BundleStarter[] = []
  clauses.forEach((clause, index) => {
    const required = clause.slots.filter((slot) => slot.min > 0)
    if (!required.length) return
    const requires = required.flatMap((slot) =>
      slot.cards.map((card) => ({
        code: card.id,
        name: card.name || nameOf(card.id) || `#${card.id}`,
      })),
    )
    // 「不能上手」的卡是这条路线的一部分：模型判断路由时必须看到
    const avoid = clause.slots
      .filter((slot) => slot.min <= 0 && slot.max === 0)
      .flatMap((slot) =>
        slot.cards.map((card) => ({
          code: card.id,
          name: card.name || nameOf(card.id) || `#${card.id}`,
        })),
      )
    // 起手满足这条启动条件的录像 = 这条启动点的实战路线
    const fromReplays = replaySources.filter((item) => clauseMatchesOpening(clause, item.opening))
    const code = `line-${String(index + 1).padStart(2, '0')}`
    starters.push({
      code,
      label: clauseLabel(clause) || requires.map((item) => item.name).join(' + '),
      requires,
      avoid,
      chance: openingChance(model, [clause], blockers, samples.handSize),
      secondChance: openingChance(model, [clause], blockers, samples.secondHandSize),
      file: fromReplays[0]?.file ?? null,
      replays: fromReplays.map((item) => ({ code: item.code, name: item.name })),
    })
  })

  // 「不能上手」的卡：只在所有路线里都只是禁止、从未被要求上手时，才算全局废件
  const requiredIdSet = new Set(starters.flatMap((starter) => starter.requires.map((item) => item.code)))
  for (const starter of starters) {
    for (const card of starter.avoid ?? []) {
      if (!requiredIdSet.has(card.code)) brickIds.add(card.code)
    }
  }

  // 卡号 → 角色
  const roles: Record<string, string[]> = {}
  const roleOf = (code: number): string[] => {
    const list: string[] = []
    for (const starter of starters) {
      if (starter.requires.some((item) => item.code === code)) list.push(starter.code)
    }
    if (handtrapIds.has(code)) list.push('handtrap')
    if (brickIds.has(code)) list.push('brick')
    return list.length ? list : ['flex']
  }
  for (const entry of input.main) roles[String(entry.id)] = roleOf(entry.id)

  // 需要写完整卡效的卡：启动卡 + 手坑 + 废件 + 录像里实际用到的卡
  const usedCardIds = new Set<number>()
  for (const starter of starters) {
    for (const item of starter.requires) usedCardIds.add(item.code)
    for (const item of starter.avoid ?? []) usedCardIds.add(item.code)
  }
  for (const id of handtrapIds) usedCardIds.add(id)
  for (const id of brickIds) usedCardIds.add(id)
  /**
   * 录像里出现过的卡也要收。
   *
   * 路线只写「检索『混沌之魔王-骸骨恶魔』」「发动『两颗心灵』」，不复述卡效；
   * 模型要判断这张卡在构筑里的作用、检索该拿谁，就得能查到它的完整文本。
   * 名字从路线文本里抠（`「…」`），只认这套卡组里真有的卡，避免把对手的卡也收进来。
   */
  const deckNameToId = new Map<string, number>()
  for (const entry of entries) deckNameToId.set(entry.name || nameOf(entry.id), entry.id)
  for (const binding of input.bindings) {
    const analysis = binding.analysis
    if (!analysis?.ok) continue
    const text = [
      ...analysis.steps.map((step) => step.text),
      ...analysis.decisions.map((decision) => decision.text),
    ].join('\n')
    for (const match of text.matchAll(/「([^」]+)」/g)) {
      const id = deckNameToId.get(match[1])
      if (id) usedCardIds.add(id)
    }
  }

  const manifest: BundleManifest = {
    // 5：路线只来自录像，去掉 10-line / lines 字段
    schemaVersion: 7,
    deck: {
      name: input.deckName,
      main: total(input.main),
      extra: total(input.extra),
      side: total(input.side),
    },
    generatedAt: new Date().toISOString(),
    files: {
      router: '00-router.md',
      fallback: '90-fallback.md',
      replays: replays.map((item) => item.file),
      cards: `${CARD_DIR}/`,
    },
    starters,
    replays,
    handtraps: handtrapDefs.map((def) => ({
      code: def.cardId as number,
      name: def.name,
      category: def.category,
    })),
    bricks: blockers.map((blocker) => ({
      cards: blocker.cards.map((card) => ({ code: card.id, name: card.name })),
      allowance: blocker.allowance,
      clear: blocker.clear,
      exempt: blocker.exempt.flatMap((clause) =>
        clause.slots.flatMap((slot) => slot.cards.map((card) => card.name)),
      ),
    })),
    roles,
    coverage,
  }

  const files: Record<string, string> = {}
  files[`${dir}/manifest.json`] = `${JSON.stringify(manifest, null, 2)}\n`

  files[`${dir}/00-router.md`] = routerMarkdown(
    input,
    manifest,
    samples,
    starters,
    handtrapDefs,
    coverage,
    replays,
  )

  for (const [file, text] of Object.entries(replayFiles)) files[`${dir}/${file}`] = text

  files[`${dir}/90-fallback.md`] = fallbackMarkdown(input, starters, samples, coverage)

  for (const entry of entries) {
    if (!usedCardIds.has(entry.id)) continue
    const card = input.cardOf?.(entry.id)
    files[`${dir}/${CARD_DIR}/${entry.id}.md`] = cardMarkdown(entry, card, nameOf)
  }

  return { files, manifest, zipName: `${safeName(input.deckName)}-skill.zip`, dir }
}

export function bundleDir(deckName: string): string {
  return `${safeName(deckName)}-skill`
}

/* ------------------------------------------------------------------ */
/* 路由层                                                              */
/* ------------------------------------------------------------------ */

function routerMarkdown(
  input: SkillInput,
  manifest: BundleManifest,
  samples: SampleReport,
  starters: BundleStarter[],
  handtrapDefs: { id: string; name: string; category: string; cardId?: number }[],
  coverage: CoverageItem[],
  replays: BundleReplay[],
): string {
  const lines: string[] = []
  const slug = safeName(input.deckName)
  lines.push('---')
  lines.push(`name: "${slug}-router"`)
  lines.push('description: "用起手 5 张判断启动点 / 手坑 / 废件，并路由到对应展开 skill"')
  lines.push(`deck: ${JSON.stringify(input.deckName)}`)
  lines.push('---', '')
  lines.push(`# ${input.deckName} · 起手路由器`, '')
  lines.push('## 怎么用', '')
  lines.push('1. 把起手卡号列出来（先攻 5 张，后攻 6 张）；')
  lines.push('2. 查下面「手牌角色」判断每张卡：启动点 / 手坑 / 废件 / 自由位；')
  lines.push('3. 按「路由规则」挑出能走的启动点，只加载对应文件，不要一次读完所有展开。', '')

  lines.push('## 路由表（机器可读）', '')
  lines.push('```json')
  lines.push(
    JSON.stringify(
      {
        starters: starters.map((starter) => ({
          code: starter.code,
          label: starter.label,
          requires: starter.requires.map((item) => item.code),
          avoid: (starter.avoid ?? []).map((item) => item.code),
          chance: round(starter.chance),
          secondChance: round(starter.secondChance),
          file: starter.file,
          replays: starter.replays,
        })),
        handtraps: handtrapDefs.map((def) => ({ code: def.cardId, name: def.name, category: def.category })),
        bricks: manifest.bricks,
        roles: manifest.roles,
      },
      null,
      2,
    ),
  )
  lines.push('```', '')

  lines.push('## 启动点', '')
  if (!starters.length) {
    lines.push('_没有配置启动条件：先在「启动率」页设置启动组 / 启动条件。_', '')
  } else {
    lines.push('| 编号 | 启动点 | 先攻命中 | 后攻命中 | 文件 | 录像样本 |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const starter of starters) {
      const replayText = starter.replays.map((item) => item.code).join('、') || '—'
      lines.push(
        `| ${starter.code} | ${starter.label} | ${pct(starter.chance)} | ${pct(starter.secondChance)} | ${starter.file || '未录入'} | ${replayText} |`,
      )
    }
    lines.push('')
  }

  if (samples.groups.length) {
    lines.push('## 代表起手', '')
    for (const group of samples.groups) {
      const sample = group.samples[0]
      if (!sample) continue
      lines.push(`- **${group.label}**（${pct(group.chance)}）：${sample.hand.map(input.nameOf).join('、')}`)
    }
    lines.push('')
  }

  if (replays.length) {
    lines.push('## 对局样本', '')
    lines.push('| 文件 | 录像 | 回合 | 手坑点 | 被自排连锁规避 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const replay of replays) {
      lines.push(
        `| ${replay.file} | ${replay.name} | ${replay.turns}${replay.incomplete ? '（未终局）' : ''} | ${replay.hits} | ${replay.dodged} |`,
      )
    }
    lines.push('')
    lines.push('> 展开流程与逐步的手坑命中点在各样本文件里；没有绑定录像时这一节为空。', '')
  }

  lines.push('## 手牌角色', '')
  lines.push('| 卡号 | 卡名 | 角色 |')
  lines.push('| --- | --- | --- |')
  for (const entry of input.main) {
    const list = manifest.roles[String(entry.id)] || ['flex']
    const label = list
      .map((role) => (role === 'handtrap' ? '手坑' : role === 'brick' ? '废件' : role === 'flex' ? '自由位' : role))
      .join('、')
    lines.push(`| ${entry.id} | ${input.nameOf(entry.id) || entry.name} | ${label} |`)
  }
  lines.push('')
  lines.push('> 手坑同时也是启动卡时，按启动点处理；`flex` 是既非启动、非手坑、非废件的普通卡。', '')

  lines.push('## 路由规则', '')
  lines.push('- 没有任何启动点 → 读 `90-fallback.md`；')
  lines.push('- 多个启动点同时成立 → 先加载命中率最高的那个文件，其余只在它被拦断后再看；')
  lines.push('- 抽到手坑 → 不影响启动判定，但要少 1 个展开位，防守优先；')
  lines.push(
    '- 启动点里的 `avoid` 是「不能上手」的卡：起手有其中任意一张，这条启动点就不成立，换别的启动点或直接防守；',
  )
  if (manifest.bricks.length) {
    lines.push(
      '- 另外还有全局废件：超过 allowance 时 `never` 型直接判定无法启动，`leaveHand` 型视为可丢弃后继续；若列了 `exempt`，与这些卡同手时该废件不生效；',
    )
  }
  lines.push(
    '- 路线分片是 `20-replay-*.md`：里面就是实战打法的完整流程与手坑命中点，按启动点表格里的文件名加载；卡效在 `cards/<卡号>.md`，没遇到就别读。',
    '',
  )

  lines.push('## 覆盖度', '')
  lines.push('| 项 | 状态 | 详情 |')
  lines.push('| --- | --- | --- |')
  for (const item of coverage) {
    lines.push(`| ${item.label} | ${coverageText(item.state)} | ${item.detail} |`)
  }
  lines.push('')
  const todos = coverage.filter((item) => item.state !== 'ok' && item.hint)
  if (todos.length) {
    lines.push('待补：', '')
    for (const item of todos) lines.push(`- **${item.label}**：${item.hint}`)
    lines.push('')
  }

  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 兜底层                                                              */
/* ------------------------------------------------------------------ */

function fallbackMarkdown(
  input: SkillInput,
  starters: BundleStarter[],
  samples: SampleReport,
  coverage: CoverageItem[],
): string {
  const lines: string[] = []
  const slug = safeName(input.deckName)
  lines.push('---')
  lines.push(`name: "${slug}-fallback"`)
  lines.push('description: "起手没有启动点、或对应路线还没录入时的兜底流程"')
  lines.push('---', '')
  lines.push('# 兜底：无启动点 / 路线缺失', '')
  lines.push('## 先确认真的没有启动点', '')
  lines.push('- 逐张核对 `00-router.md` 的手牌角色表：`flex` 卡里可能藏着未登记的启动点；')
  lines.push('- 只有「需要 ≥2 张」的组命中其中 1 张时，不算启动，按单卡路线走；')
  lines.push('- 手坑不算启动点，但如果卡组有「手坑 + 单卡」的两卡组合，按路由表判定。', '')

  const missing = starters.filter((starter) => !starter.file)
  if (missing.length) {
    lines.push('## 能启动但路线未录入', '')
    for (const starter of missing) lines.push(`- ${starter.code}：${starter.label}（命中率 ${pct(starter.chance)}）`)
    lines.push('')
    lines.push(
      '处理方式：按最接近的已录入路线近似；最好是录一局用这条启动点展开的对局、绑定到卡组后重新生成 skill。',
      '',
    )
  }

  if (samples.groups.some((group) => group.kind === 'none')) {
    const none = samples.groups.find((group) => group.kind === 'none')
    if (none) {
      lines.push('## 无启动点', '')
      lines.push(`- 概率：${pct(none.chance)}（按当前启动条件）`)
      lines.push('- 处理：优先用抽滤 / 检索找启动点；没有就转防守，把手坑 / 盖放留到对手回合。')
      lines.push('')
    }
  }

  lines.push('## 断链恢复', '')
  lines.push('- 回到对应 `20-replay-*.md`，按「展开流程」逐条对齐，确认断在哪一步；')
  lines.push('- 再看该分片的「手坑命中点」：哪一步被拦、命中后原本还剩哪些场面，据此决定继续展开还是转防守；')
  lines.push('- 若断链发生在 route 的第 N 步，后面的步骤不要按原路线继续执行。', '')

  const todos = coverage.filter((item) => item.state !== 'ok' && item.hint)
  if (todos.length) {
    lines.push('## 还缺什么', '')
    for (const item of todos) lines.push(`- **${item.label}**：${item.hint}`)
    lines.push('')
  }

  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 录像层                                                              */
/* ------------------------------------------------------------------ */

function replayMarkdown(input: SkillInput, name: string, analysis: ReplayAnalysis, code: string): string {
  const slug = safeName(input.deckName)
  const lines: string[] = []
  lines.push('---')
  lines.push(`name: "${slug}-${code}"`)
  lines.push(`description: ${JSON.stringify(`对局录像「${name}」：展开流程与手坑命中点`)}`)
  lines.push('---', '')
  lines.push(`# 对局录像：${name}`, '')
  lines.push(
    `- 回合数：${analysis.turns}${analysis.incomplete ? '（录像未跑到终局）' : ''}`,
    `- 起手 ${analysis.startingHand} 张：${analysis.openingHand.map(input.nameOf).join('、') || '—'}`,
    '',
  )

  const flow = actionableSteps(analysis.steps)
  if (flow.length) {
    lines.push('## 展开流程', '')
    flow.forEach((step, index) => {
      const where = step.turn ? `T${step.turn}${step.phase ? ` · ${step.phase}` : ''}` : ''
      const who = step.player === 0 ? '我方' : '系统'
      lines.push(`${index + 1}. 【${where || who}】${step.text}`)
    })
    lines.push('')
  }

  /**
   * 决策序列按阶段串成一行。
   *
   * 一份正常展开有 150+ 条决策，逐行列出光这一段就 5 KB 以上，会把分片顶到
   * `read_skill` 的截断线外面——模型只读到抽卡阶段，主要阶段的展开全丢。
   * 串起来之后同样的信息只占几行，一次读完还能看清「发动 → 选项 → 选卡」的顺序。
   */
  if (analysis.decisions.length) {
    lines.push('## 决策序列', '')
    const groups = new Map<string, string[]>()
    for (const decision of analysis.decisions) {
      const where = decision.turn ? `T${decision.turn}${decision.phase ? ` · ${decision.phase}` : ''}` : ''
      const list = groups.get(where) ?? []
      list.push(decision.text)
      groups.set(where, list)
    }
    for (const [where, items] of groups) {
      lines.push(`- ${where ? `【${where}】` : ''}${items.join(' → ')}`)
    }
    lines.push('')
  }

  const hits = analysis.handtrapHits ?? []
  lines.push('## 手坑命中点', '')
  if (hits.length) {
    lines.push('| 位置 | 手坑 | 触发点 | 后果 |')
    lines.push('| --- | --- | --- | --- |')
    for (const hit of hits) {
      lines.push(`| ${hitPositionText(hit)} | ${hitNameText(hit)} | ${hit.trigger} | ${hitConsequenceText(hit)} |`)
    }
    lines.push('')
    lines.push('> 录像里没有对手手牌，以上是「对手手上正好有这张卡」时的潜在命中点。', '')
    if (hits.some((hit) => hit.dodged)) lines.push(`> ${HANDTRAP_FOOTNOTE}`, '')
  } else {
    lines.push('_没有识别到命中点（录像太短，或旧缓存还没重新解析）。_', '')
  }

  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 卡效                                                                */
/* ------------------------------------------------------------------ */

function cardMarkdown(entry: DeckEntry, card: CardData | undefined, nameOf: (code: number) => string): string {
  const name = card?.name || nameOf(entry.id) || entry.name
  const lines: string[] = []
  lines.push(`# ${name}（#${entry.id}）`, '')
  if (card?.typeLine) lines.push(`- 类型：${card.typeLine}`)
  if (card?.kinds.length) lines.push(`- 分类：${card.kinds.join('、')}`)
  if (card?.attribute) lines.push(`- 属性：${card.attribute}`)
  if (card?.race) lines.push(`- 种族：${card.race}`)
  if (typeof card?.level === 'number') lines.push(`- 等级 / 阶级：${card.level}`)
  if (typeof card?.atk === 'number' || card?.atk === null) lines.push(`- ATK：${card?.atk ?? '?'}`)
  if (typeof card?.def === 'number' || card?.def === null) lines.push(`- DEF：${card?.def ?? '?'}`)
  lines.push('')
  const desc = (card?.desc || '').trim()
  lines.push(desc ? `## 效果\n\n${truncate(desc)}` : '## 效果\n\n_卡库没有这张卡的效果文本。_')
  const pend = (card?.pendDesc || '').trim()
  if (pend) lines.push('', `## 灵摆\n\n${truncate(pend)}`)
  return `${lines.join('\n')}\n`
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function coverageText(state: CoverageItem['state']): string {
  if (state === 'ok') return '达标'
  if (state === 'partial') return '部分'
  return '缺失'
}

function total(list: DeckEntry[]): number {
  return list.reduce((sum, entry) => sum + Math.max(0, Math.floor(Number(entry.count) || 0)), 0)
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000
}

function truncate(text: string): string {
  return text.length > MAX_CARD_TEXT ? `${text.slice(0, MAX_CARD_TEXT)}…` : text
}

function safeName(deckName: string): string {
  return deckName.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'deck'
}
