import type { AiMessage } from './provider'
import type { AnswerPlan } from './question'

/**
 * prompt 组装。
 *
 * 缓存友好是硬约束：RULES_SUMMARY 与 skill 索引必须放在最前面且逐字节稳定，
 * 变化的部分（局面、候选、历史）全部追加在尾部，这样前缀缓存才命中。
 */

/** 固定规则摘要：所有请求共用，前缀缓存能命中 */
export const RULES_SUMMARY = `你是游戏王 OCG（新大师规则 2020，MR5）的对战决策器，替「我方」玩家做操作。

基本事实：
- 主要阶段 1 之后是战斗阶段，再是主要阶段 2。额外怪兽区在 5、6 号位。
- 一次发动分四段：置入魔陷区 → 支付 cost → 效果处理 → 结算后送墓。cost 与规则动作永不被手坑无效，只有效果处理能被无效。
- 同名卡必须来自同一区域才能互相连接；从卡组取牌不校验余量。
- 常见阻抗：灰流丽（卡组→手卡/墓地/怪兽区 的效果处理）、无限泡影（场上的怪兽效果）、屋敷童（墓地→手卡/卡组/怪兽区）、幽鬼兔（已表侧在场的卡）、锁鸟（主要阶段的卡组检索，每局一次）、尼比鲁（第 5 次召唤/特召之后）、灵王的波动（含特召的效果整次无效）。

决策原则：
1. 优先保证启动点先落地：手里有能展开的起动卡，先落地再考虑检索与盖放。
2. 检索按后续路线的缺口选目标，不要凭喜好或同名卡习惯选。
3. 能做出阻抗终端时先做场，再补后手资源。
4. 只在能扩大场面或保证不断链时继续操作；无意义的空过会浪费整个回合。
5. 连锁响应只在能获得收益（无效对手、保护自己、抽卡）时进行，否则放弃响应窗口。`

/**
 * 输出约定。
 *
 * prompt 里必须出现 "json"，JSON 模式才可靠；多选与单选的动作字段形态不同，
 * 必须写清楚，否则模型会把数组当成一个编号塞进数字字段。
 */
export function outputRule(plan: AnswerPlan | null): string {
  const head =
    '输出要求：只输出一个 json 对象，不要代码块、不要解释文字。action 必须与你写下的理由一致——不要理由说选 2、action 却给 1。'
  if (!plan || plan.mode === 'single') {
    return `${head}\n格式：{"action": <候选编号>, "reason": "<不超过 30 字的中文理由>"}`
  }
  if (plan.mode === 'order') {
    return `${head}\n格式：{"action": [<编号>, ...], "reason": "..."}\n数组顺序就是提交顺序，必须包含全部编号且不重复。`
  }
  const count = plan.min === plan.max ? `必须选 ${plan.min} 个` : `选 ${plan.min} 到 ${plan.max} 个`
  const cancel = plan.cancel ? '；这个提问允许放弃，选「取消」那一项即可' : '；必须做出选择，不能跳过'
  return `${head}\n格式：{"action": [<编号>, ...], "reason": "..."}\n数量要求：${count}${cancel}。编号之间不能重复，每个编号代表一张卡。`
}

export interface Plan {
  route: string
  goal: string
  steps: string[]
  avoid: string[]
  handtraps: string[]
  /** 规划时的回合数；跨回合要重规划 */
  turn: number
}

export interface PlanPromptInput {
  deckName: string
  handNames: string[]
  deckNames: string[]
  extraNames: string[]
  /** router + 分片索引（不是全文，全文由 read_skill 工具按需拉取） */
  skillIndex: string
  skillBudget: number
  /**
   * 与这手起手匹配的录像路线（完整步骤）。
   *
   * 直接摆进规划 prompt，不指望模型自己想起来 read_skill：路线是这套卡组的真打法，
   * 规划一旦偏离它，整条展开都会跟着走歪。
   */
  replay?: string
  /**
   * 这条路线用到的卡的效果原文（`cards/<code>.md`）。
   *
   * 只给卡名清单 + 索引时，模型不会主动 read_skill，而是按卡名联想效果——
   * 「墓地 3 张卡回卡组」这类幻觉就是这么来的。原文直接摆进 prompt。
   */
  cardEffects?: string
  /**
   * 当前盘面。初次规划也要传——抽卡阶段的第一条连锁打完后手卡里可能已经没有启动卡，
   * 但录像的前几步已经落地了，只看手牌会误判成「无法展开」。
   */
  board?: string
  /** 最近操作（「已发动栗球兽卫、已盖放两颗心灵」这类事实只能从这里看出来） */
  history?: string[]
}

/** 起手路线规划：手牌 + 卡组 + skill 索引 → 一条可执行路线 */
export function buildPlanMessages(input: PlanPromptInput): AiMessage[] {
  const index = input.skillIndex.slice(0, input.skillBudget)
  const system = [
    RULES_SUMMARY,
    '',
    '【本卡组的展开知识库索引】',
    index || '（这套卡组没有录入 skill，按卡面常识决策）',
    input.replay ? '\n【这套卡组的实战录像路线】\n' + input.replay : '',
    input.replay ? '这条路线就是本卡组的实际打法：steps 按它的顺序与卡名写，不要用通用常识替换。' : '',
    input.cardEffects ? '\n' + input.cardEffects : '',
    input.cardEffects
      ? '以上是效果原文：发动条件、取牌来源（手卡 / 卡组 / 墓地 / 除外）、数量与代价都以它为准，不要按卡名联想。'
      : '',
  ]
    .filter((part) => part !== '')
    .join('\n')

  const user = [
    `卡组：${input.deckName}`,
    `起手：${input.handNames.join('、') || '（未知）'}`,
    `主卡组构成：${input.deckNames.join('、')}`,
    `额外卡组：${input.extraNames.join('、')}`,
    input.history?.length ? `\n【已经发生的操作】\n${input.history.slice(-8).join('\n')}` : '',
    input.board ? `\n【当前局面】\n${input.board}` : '',
    '',
    '先判断这手牌能打成什么，再给一条优先执行的路线。需要细节时调用 read_skill 读具体分片。',
    '如果「启动点 → 路线文件」里这条起手命中了录像分片（20-replay-*.md），先 read_skill 读完它再规划：',
    '录像里的顺序、卡名、效果分支（丢弃谁、盖哪张、检索谁、要不要发墓效）就是这套卡组的真打法，不要用通用常识替换。',
    'steps 尽量按录像的实际顺序展开，不要跳步、不要合并；录像里出现的卡，前面必须写出获取途径（检索 / 特殊召唤 / 盖放），',
    '不要凭空写出场上没有的卡——执行时是照卡名对候选的，对不上就没有这一步。',
    '录像里的「丢弃 1 张手卡」「选择一张卡」具体选谁，以「录像里这次实际选中的卡」为准，不要自己挑一张看起来没用的。',
    '录像可能已经走到中途（起手的启动卡已丢弃 / 已进墓地，前几步已经落地）：判断适用性看「已经发生的操作 + 当前局面」，',
    '不要因为手卡里没有启动卡就判成「无法展开」——那多半是录像的前几步已经做完了，接着往下写就行。',
    input.cardEffects
      ? '上面给了效果原文的卡，效果细节必须以原文为准；写出来的「从卡组 / 从手卡 / 回卡组 / 除外」不能和原文冲突。'
      : '没有给效果原文的卡，只写「发动 / 盖放 / 检索」这类动作，不要编造它的具体效果。',
    '要求：steps 每一步都要写到具体卡名，例如「通召『巳剑降临』检索『巳剑之仪』」。',
    '不要写「检索一张卡」「特召一个怪兽」这类模糊描述——后续执行会按卡名对照路线，写不出卡名就无法照路线走。',
    'steps 一条只写一个动作——不要在一行里塞「通召 X → 特召 Y → 做 Z」，那样执行时对不上候选。',
    '输出规模（超了会被截断，整条路线就作废）：steps 最多 20 条、每条不超过 45 字；goal 不超过 50 字；avoid / handtraps 各不超过 4 条。',
    '输出 json：',
    '{"route":"路线名","goal":"本回合终场目标","steps":["按顺序的关键操作，必须含具体卡名"],"avoid":["要避免的错误"],"handtraps":["对手可能的手坑与应对"]}',
  ]
    .filter((part) => part !== '')
    .join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export function parsePlan(raw: Record<string, unknown>, turn: number): Plan {
  // steps 多留几条：一份完整展开的「后半」全靠它，截在 10 条会让后面的操作判成「路线未覆盖」
  const toList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string').slice(0, 24)
      : []
  return {
    route: typeof raw.route === 'string' ? raw.route.slice(0, 60) : '未命名路线',
    goal: typeof raw.goal === 'string' ? raw.goal.slice(0, 200) : '',
    steps: toList(raw.steps),
    avoid: toList(raw.avoid),
    handtraps: toList(raw.handtraps),
    turn,
  }
}

export function renderPlan(plan: Plan): string {
  const lines = [`当前路线：${plan.route}`, `本回合目标：${plan.goal || '未指定'}`]
  if (plan.steps.length) {
    lines.push(`执行顺序：${plan.steps.map((step, index) => `${index + 1}) ${step}`).join('；')}`)
  }
  if (plan.avoid.length) lines.push(`避免：${plan.avoid.join('；')}`)
  if (plan.handtraps.length) lines.push(`手坑应对：${plan.handtraps.join('；')}`)
  return lines.join('\n')
}

export interface PlanStepRef {
  /** 1 起的步骤号，与候选上的〔路线第 N 步〕同一套编号 */
  step: number
  text: string
}

/**
 * 路线的局部窗口。
 *
 * 决策 prompt 原来塞整条 plan（20 步约 1500 字），模型得自己在里面找出
 * 「现在该做第几步」——本质是让它做长文本里的指针运算，
 * 「路线第 7 步写的是从手卡，它记成从卡组」就是这么来的。
 * 只给「刚做完 / 现在这一步 / 接下来」三步，注意力就落在局部。
 */
export interface PlanFocus {
  route: string
  goal: string
  total: number
  done: PlanStepRef[]
  /** null 表示路线里的步骤都执行过了 */
  current: PlanStepRef | null
  next: PlanStepRef[]
  avoid: string[]
  handtraps: string[]
}

export function renderPlanFocus(focus: PlanFocus): string {
  const refs = (items: PlanStepRef[]) => items.map((item) => `${item.step}) ${item.text}`).join('；')
  const lines = [`【路线进度】${focus.route}（共 ${focus.total} 步）`]
  if (focus.goal) lines.push(`本回合目标：${focus.goal}`)
  if (focus.done.length) lines.push(`刚做完：${refs(focus.done)}`)
  lines.push(
    focus.current
      ? `现在这一步（第 ${focus.current.step} 步）：${focus.current.text}`
      : '路线里的步骤都已经执行过：按场面收尾（做终端 / 补后场），不要重复已经做过的动作。',
  )
  if (focus.next.length) lines.push(`接下来：${refs(focus.next)}`)
  if (focus.avoid.length) lines.push(`避免：${focus.avoid.join('；')}`)
  if (focus.handtraps.length) lines.push(`手坑应对：${focus.handtraps.join('；')}`)
  return lines.join('\n')
}

/** 重规划：路线被打断后，带着「发生了什么」再规划一次 */
export function buildReplanMessages(
  input: PlanPromptInput & { previous: Plan | null; interruption: string; board: string },
): AiMessage[] {
  const messages = buildPlanMessages(input)
  // 盘面已经在 buildPlanMessages 的 user 里了，这里只说「为什么重规划」
  const tail = [
    '',
    `【上一次的路线】${input.previous ? renderPlan(input.previous) : '（没有）'}`,
    `【打断事件】${input.interruption || '（不明）'}`,
    '',
    '上面的打断让原路线无法继续，请给出新的路线（格式同上）。',
  ].join('\n')
  const last = messages[messages.length - 1]
  if (last.role === 'user') {
    messages[messages.length - 1] = { role: 'user', content: `${last.content}\n${tail}` }
  }
  return messages
}

export interface DecidePromptInput {
  board: string
  label: string
  /** 回答形态：决定输出是单个编号还是编号数组 */
  answer: AnswerPlan
  candidates: { id: number; text: string }[]
  /** 路线的局部进度窗口：只给 ±2 步，不给整条路线 */
  focus: PlanFocus | null
  /** 最近若干步的操作摘要，追加在末尾 */
  history: string[]
  /** 卡组角色摘要（启动点 / 手坑 / 废件），用于还没规划时的单步判断 */
  skillBrief?: string
  /** 候选里是否有〔录像第 N 步〕标注：有就追加一句「优先选它」 */
  replayAligned?: boolean
}

/** 单步决策：局面 + 候选 + 路线，不再重复塞 skill 全文 */
export function buildDecideMessages(input: DecidePromptInput): AiMessage[] {
  const system = [
    RULES_SUMMARY,
    '',
    input.skillBrief
      ? [
          '【卡组角色与录像】',
          input.skillBrief,
          '判定要求：',
          '1. 有录像路线时以录像为准——它就是这套卡组的实际打法，包括「丢弃某张卡去盖关键展开件」这类操作；',
          '2. 没有录像可参考时，启动点是展开的根基，不要只因为「现在能响应」就丢掉；手卡里的手坑才是阻抗；',
          '3. 既没有录像也没有收益的响应窗口才放弃。',
        ].join('\n')
      : '',
    '',
    input.focus
      ? [
          '【路线执行要求】',
          '1. 以「现在这一步」为唯一目标：它写「从卡组」，就按从卡组处理，不要记成从手卡；它写「丢弃 X」，就不要丢别的卡。',
          '2. 现在这一步在当前提问里没有对应候选时，再看「接下来」；都覆盖不到才按场面自己判断。',
          '3. 「刚做完」的步骤不要再做一遍；路线还有没做完的步骤时，不要选「结束回合」「进入战斗阶段」这类收尾动作。',
        ].join('\n')
      : '【当前路线】（尚未规划，按上面的卡组角色与最优展开直觉操作）',
    '',
    outputRule(input.answer),
  ]
    .filter((part) => part !== '')
    .join('\n')

  const multi = input.answer.mode !== 'single'
  const list = input.candidates.map((item) => `${item.id}. ${item.text}`).join('\n')
  const user = [
    input.focus ? `${renderPlanFocus(input.focus)}\n` : '',
    '【局面】',
    input.board,
    '',
    `【当前提问】${input.label}`,
    multi ? '【候选卡片】每行是一张可选的卡，不是一组' : '【候选动作】',
    list,
    input.replayAligned
      ? [
          '候选末尾的〔…〕是线索：〔路线第 N 步〕是它在既定路线里的位置——**先看这个**，编号小的先做，标「（已执行）」的跳过；',
          '〔录像第 N 步：…〕是实战录像里的位置；〔录像里选过这张〕是这张卡在录像里被选中过。',
          '标 ★ 的候选是录像在同一步选过、且只有一个候选能对上的，直接选它。',
          '如果多个候选都写着「录像里用过这个分支」，说明录像在不同场合分别选过，此时按〔路线第 N 步〕小的那个选。',
        ].join('')
      : '',
    input.history.length ? `【最近操作】\n${input.history.join('\n')}` : '',
    '',
    multi
      ? `请选出满足数量要求的编号，只输出 json（action 是数组）。`
      : '请选一个候选动作，只输出 json。',
  ]
    .filter(Boolean)
    .join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
