import type { SkillBundle } from '@/lib/skillBundle'

/**
 * 把 skill 分片包变成模型可按需读取的知识库。
 *
 * 规划阶段只注入「路由层 + 分片索引」，细节（每条展开路线的完整步骤、
 * 每张卡的完整效果）留给 `read_skill` 工具按需拉取：
 * 一次注入十几万字既不经济，也会把有效信息淹掉。
 */

export interface SkillSection {
  /** 分片 id，就是去掉扩展名的相对路径，例如 `20-replay-01` 或 `cards/89631139` */
  id: string
  title: string
  chars: number
  text: string
}

export interface SkillSource {
  deckName: string
  router: string
  sections: SkillSection[]
  /** 注入 prompt 的索引文本 */
  index: string
  /**
   * 极简「卡组角色」摘要（启动点 / 手坑 / 废件）。
   *
   * 单步决策（`decide`）用 json 模式且不带工具，塞不进 router，也不能 read_skill；
   * 不给这段的话模型看到「连锁发动『栗球兽卫』」只会把它当成一张普通可用的卡，
   * 于是把唯一启动点当阻抗丢掉。
   */
  brief: string
  /** 卡名 → 角色：给候选动作直接打标（`召唤「栗球兽卫」〔启动点〕`） */
  roles: { starters: string[]; handtraps: string[]; bricks: string[] }
  /** 录像路线：起手 + 前几步操作，按当前手牌挑一条塞进单步决策 */
  replays: { code: string; file: string; opening: string[]; steps: string[]; options: string[]; picks: string[] }[]
  /**
   * 卡名 → 卡效分片全文（`cards/<code>.md`）。
   *
   * 规划阶段不能指望模型主动 `read_skill`：43 份分片摆在那里它也会凭卡名联想，
   * 于是编出「墓地 3 张卡回卡组」这种不存在的效果。按「这条路线真会碰到的卡」
   * 直接取原文塞进 prompt，是消除效果幻觉唯一可靠的写法。
   */
  cardEffects: Record<string, string>
}

const ROUTER_MAX = 6000

function firstHeading(text: string): string {
  const lines = text.split('\n')
  let index = 0
  // 跳过 YAML front matter：否则标题会变成「---」，模型从索引里看不出这份分片是什么
  if (lines[0]?.trim() === '---') {
    index = 1
    while (index < lines.length && lines[index].trim() !== '---') index += 1
    index += 1
  }
  for (; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (!trimmed) continue
    return trimmed.replace(/^#+\s*/, '').slice(0, 80)
  }
  return ''
}

/** 去掉 `<卡组>-skill/` 前缀，只留分片 id */
function relativeId(path: string, prefix: string): string {
  const rel = path.startsWith(prefix) ? path.slice(prefix.length) : path
  return rel.replace(/\.md$/i, '')
}

export function buildSkillSource(bundle: SkillBundle | null): SkillSource | null {
  if (!bundle) return null
  const prefix = `${bundle.dir}/`
  const paths = Object.keys(bundle.files)
  const sections: SkillSection[] = []
  const cardEffects: Record<string, string> = {}
  let router = ''

  for (const path of paths.sort()) {
    if (!path.startsWith(prefix)) continue
    const text = bundle.files[path]
    if (!text) continue
    if (path.endsWith('/00-router.md')) {
      router = text
      continue
    }
    const id = relativeId(path, prefix)
    if (id.startsWith('cards/')) {
      const name = cardNameOf(text)
      if (name) cardEffects[name] = text
    }
    sections.push({
      id,
      title: firstHeading(text),
      chars: text.length,
      text,
    })
  }

  const lines = sections
    .filter((section) => !section.id.startsWith('cards/'))
    .map((section) => `- ${section.id}（${section.chars} 字）：${section.title}`)
  const cardCount = sections.filter((section) => section.id.startsWith('cards/')).length
  /**
   * 启动点 → 路线文件的紧凑摘要。
   *
   * router 里有完整表格，但它常被 ROUTER_MAX 截断（手牌角色表能占掉一半），
   * 截断后模型就看不到「这条启动点该读哪个分片」。这里从 manifest 直接生成一遍，
   * 保证不管 router 多长，路由信息都在。
   */
  const starters = bundle.manifest.starters.map((starter) => {
    const target = starter.file || '未录入路线'
    const replayText = starter.replays.length
      ? `（录像 ${starter.replays.map((item) => item.code).join('、')}）`
      : ''
    return `- ${starter.code}「${starter.label}」→ ${target}${replayText}`
  })
  const index = [
    `卡组：${bundle.manifest.deck.name}`,
    router.slice(0, ROUTER_MAX),
    router.length > ROUTER_MAX ? '（router 已截断，需要全文时 read_skill 读 `00-router`）' : '',
    '',
    '【启动点 → 路线文件】',
    starters.length ? starters.join('\n') : '- （没有配置启动条件）',
    '',
    '【可读取的分片】用 read_skill 工具按 id 读取：',
    lines.join('\n'),
    cardCount ? `- 另有 ${cardCount} 份单卡效果分片（cards/<卡号>）` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const replays = bundle.manifest.replays.map((item) => ({
    code: item.code,
    file: item.file,
    opening: item.opening ?? [],
    steps: item.steps ?? [],
    options: item.options ?? [],
    picks: item.picks ?? [],
  }))

  /**
   * 卡组角色摘要：只列名单，不列卡效。
   * 单步决策要的是「这张卡在本构筑里是什么身份」，而不是它的完整文本。
   */
  const brief = [
    `卡组：${bundle.manifest.deck.name}`,
    // 录像数是排障关键：为 0 时模型拿不到任何打法，只能瞎猜
    `录像：${replays.length ? replays.map((item) => item.code).join('、') : '（没有绑定录像，路线未知）'}`,
    `启动点：${
      bundle.manifest.starters.map((starter) => `${starter.label}（${starter.code}）`).join('；') ||
      '（没有配置启动条件）'
    }`,
    `手坑：${bundle.manifest.handtraps.map((item) => item.name).join('、') || '（无）'}`,
    `废件：${
      [
        ...bundle.manifest.bricks.flatMap((brick) =>
          brick.cards.map(
            (card) =>
              `${card.name}（上限 ${brick.allowance}，${brick.clear}${
                brick.exempt?.length ? `，与 ${brick.exempt.join(' / ')} 同手时豁免` : ''
              }）`,
          ),
        ),
        ...bundle.manifest.starters.flatMap((starter) =>
          (starter.avoid ?? []).map((card) => `${card.name}（${starter.code} 不能上手）`),
        ),
      ].join('、') || '（无）'
    }`,
  ].join('\n')

  const roles = {
    starters: bundle.manifest.starters.flatMap((starter) => starter.requires.map((item) => item.name)),
    handtraps: bundle.manifest.handtraps.map((item) => item.name),
    bricks: [
      ...new Set([
        ...bundle.manifest.bricks.flatMap((brick) => brick.cards.map((card) => card.name)),
        ...bundle.manifest.starters.flatMap((starter) =>
          (starter.avoid ?? []).map((card) => card.name),
        ),
      ]),
    ],
  }

  return { deckName: bundle.manifest.deck.name, router, sections, index, brief, roles, replays, cardEffects }
}

/** 单张卡效注入的字数上限：够写完整段效果（含灵摆 / 多条 ①②③），又不至于把预算吃光 */
const CARD_EFFECT_MAX = 1200
/** 规划阶段卡效注入的总字数上限（约 2~3k token） */
const CARD_EFFECTS_BUDGET = 6000

/** `cards/<code>.md` 的首行是 `# 卡名（#12345678）` */
const CARD_HEADING = /^#\s*(.+?)（#\d+）\s*$/m

function cardNameOf(text: string): string {
  return CARD_HEADING.exec(text)?.[1]?.trim() ?? ''
}

/** 把分片整理成 `### 卡名` + 类型行 + 效果，去掉重复的标题行 */
function effectBlock(text: string, name: string): string {
  const body = text
    .split('\n')
    .filter((line) => !/^#\s/.test(line))
    .join('\n')
    .trim()
  if (!body) return ''
  const clipped = body.length > CARD_EFFECT_MAX ? `${body.slice(0, CARD_EFFECT_MAX)}…` : body
  return `### ${name}\n${clipped}`
}

/**
 * 规划阶段注入的卡效原文。
 *
 * `names` 传「这条路线真会碰到的卡」（起手 + 录像步骤 / 实际选中 / 当前场面），
 * 按顺序拼到总预算用完为止。返回空串表示没有可注入的分片。
 */
export function cardEffectsFor(source: SkillSource | null, names: string[]): string {
  if (!source) return ''
  const seen = new Set<string>()
  const blocks: string[] = []
  let budget = CARD_EFFECTS_BUDGET
  for (const raw of names) {
    const name = raw.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    const text = source.cardEffects[name]
    if (!text) continue
    const block = effectBlock(text, name)
    if (!block) continue
    /**
     * 预算用完就停，不要 `continue` 去试后面的短卡：
     * 顺序就是优先级，跳过一张会把预算让给排在后面的无关卡
     * （日志里巳剑线的卡就是这么被第 2 回合黑魔女线的卡挤掉的）。
     */
    if (block.length > budget) break
    budget -= block.length
    blocks.push(block)
    if (budget <= 0) break
  }
  return blocks.length ? `【这条路线用到的卡（效果原文）】\n${blocks.join('\n\n')}` : ''
}

const REPLAY_HINT_MAX = 900
/** prompt 里只摆前几步，编号（录像第 N 步）也按这一段算 */
const REPLAY_STEPS_SHOWN = 8

export interface ReplayRoute {
  code: string
  opening: string[]
  steps: string[]
  /** 录像里效果分支实际选了哪些选项 */
  options: string[]
  /** 录像里「选择卡片」实际选中过的卡名 */
  picks: string[]
}

/**
 * 挑一条录像当路线参考。
 *
 * 抽卡阶段这类提问发生在规划之前，模型拿不到 plan。只告诉它「Griffoh 是启动点」不够——
 * 它不知道「丢弃 Griffoh 是为了从卡组盖『两颗心灵』，而那张卡本回合就能用」。
 * 所以把录像的前几步直接摆进 prompt。
 *
 * `focus` 是当前局面里所有可见的卡名（手卡 + 墓地 + 当前连锁）：
 * 起手重合、步骤里点到这些卡都算命中；一份都对不上时也仍然给第一条——
 * 卡组绑定的录像本来就是这套构筑的打法，有参考远好过让模型在两个分支间瞎猜。
 */
export function pickReplayRoute(source: SkillSource | null, focus: string[]): ReplayRoute | null {
  if (!source || !source.replays.length) return null
  const names = new Set(focus.filter(Boolean))
  const best = source.replays
    .map((replay) => {
      const openingHit = replay.opening.filter((name) => names.has(name)).length
      const stepHit = replay.steps.filter((step) => [...names].some((name) => step.includes(name))).length
      return { replay, score: openingHit * 2 + stepHit }
    })
    .sort((a, b) => b.score - a.score)[0]
  if (!best || !best.replay.steps.length) return null
  return best.replay
}

export function pickReplayHint(source: SkillSource | null, focus: string[]): string {
  const replay = pickReplayRoute(source, focus)
  if (!replay) return ''

  const lines = [
    `【录像路线 ${replay.code}】${replay.opening.length ? `起手：${replay.opening.join('、')}` : ''}`,
    ...replay.steps.slice(0, REPLAY_STEPS_SHOWN).map((step, index) => `${index + 1}. ${step}`),
  ].filter(Boolean)
  const text = lines.join('\n')
  return text.length > REPLAY_HINT_MAX ? `${text.slice(0, REPLAY_HINT_MAX)}…` : text
}

/** 动作词，长的在前：『特殊召唤』包含『召唤』，必须按长度顺序判定 */
const STEP_ACTIONS = ['额外卡组特召', '特殊召唤', '盖放', '变更', '攻击', '召唤', '发动']

/** 负面 / 非动作候选：『不发动』里也含『发动』，不排掉就会被错标成录像的某一步 */
const NEGATIVE_ACTIONS = ['不发动', '放弃', '取消', '结束回合', '进入', '确认']

function actionOf(text: string): string {
  return STEP_ACTIONS.find((word) => text.includes(word)) ?? ''
}

/**
 * 把候选动作对齐到录像步骤。
 *
 * 内核给的选项常常只是「伤害改变 / 盖放魔陷」这种脱离卡名的分支名，
 * 光看候选根本不知道它对应录像里的哪一步——而录像里明明写着
 * 「盖放『两颗心灵』」。这里按「动作词 + 卡名」把候选标到具体步骤上，
 * 由调用方写成 `盖放魔陷〔录像第 3 步：我方盖放「两颗心灵」〕`。
 *
 * 保守原则：动作词必须一致；候选自己带卡名时，录像步骤也必须点到同一张卡。
 * 一条步骤只认领一个候选，避免「两张卡都盖放」时给出错误暗示。
 */
export function alignReplaySteps(
  candidates: { id: number; text: string }[],
  replay: ReplayRoute | null,
): Map<number, { step: number; text: string }> {
  const aligned = new Map<number, { step: number; text: string }>()
  if (!replay) return aligned
  const steps = replay.steps.slice(0, REPLAY_STEPS_SHOWN)
  const used = new Set<number>()
  for (const candidate of candidates) {
    if (NEGATIVE_ACTIONS.some((word) => candidate.text.includes(word))) continue
    const action = actionOf(candidate.text)
    if (!action) continue
    const name = /「([^」]+)」/.exec(candidate.text)?.[1] ?? ''
    for (let index = 0; index < steps.length; index += 1) {
      if (used.has(index)) continue
      const step = steps[index]
      if (actionOf(step) !== action) continue
      if (name && !step.includes(name)) continue
      used.add(index)
      // 去掉「抽卡阶段：」这类阶段前缀，只留操作本身
      aligned.set(candidate.id, { step: index + 1, text: step.replace(/^[^：:]*[：:]/, '') })
      break
    }
  }
  return aligned
}

/** read_skill 的实现：按 id 精确取，也允许 `20-replay-01.md` 这种带后缀的写法 */
export function readSkillSection(source: SkillSource | null, id: string): string | null {
  if (!source) return null
  const key = id.trim().replace(/\.md$/i, '')
  if (!key) return null
  if (key === 'router' || key === '00-router') return source.router
  const hit = source.sections.find((section) => section.id === key)
  return hit ? hit.text : null
}
