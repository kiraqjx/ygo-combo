import { OcgLocation, OcgMessageType, type OcgResponse } from 'ocgcore-wasm'
import { autoRespond } from '@/lib/duel/auto'
import type { DuelQuestion, DuelSignal, DuelStateView } from '@/lib/duel/types'
import { zoneLabel } from '@/lib/duel/labels'
import type { AiConfig } from './config'
import { chat, parseJsonObject, type AiMessage, type AiTool, type ChatOptions } from './provider'
import {
  answerPlan,
  buildAnswerResponse,
  enumerateCandidates,
  questionLabel,
  type AnswerPlan,
  type Candidate,
} from './question'
import { renderBoard } from './board'
import {
  buildDecideMessages,
  buildPlanMessages,
  buildReplanMessages,
  parsePlan,
  renderPlan,
  type Plan,
  type PlanFocus,
  type PlanStepRef,
} from './prompt'
import {
  alignReplaySteps,
  cardEffectsFor,
  pickReplayHint,
  pickReplayRoute,
  readSkillSection,
  type SkillSource,
} from './skillContext'

/**
 * 对局代打驱动。
 *
 * 用户定的策略是「先规划一条路线，然后照着打；只有被手坑 / 阻抗打断才叫模型决策」，
 * 所以只有两种模式：
 *   planning  —— 起手、被打断、路线资源耗尽时才问模型要一条路线（可带 read_skill）
 *   executing —— 路线在手就**全部本地执行**：候选能按路线卡名对上就照路线走，
 *                对不上退确定性策略；解放 / 弃手卡 / 格位这类岔路不再逐条问模型
 *
 * 只有「还没有路线」或「刚检测到打断」才走 `decide()`。
 * 连续 `MAX_UNMATCHED` 步对不上路线视为偏离，下一次 idle 触发重规划。
 */

export type AgentStatus = 'idle' | 'planning' | 'thinking' | 'error'

/** 一次请求的开销（相对上一条日志的增量） */
export interface AgentTokens {
  calls: number
  prompt: number
  completion: number
  cacheHit: number
}

export interface AgentTrace {
  at: number
  kind: 'plan' | 'replan' | 'decide' | 'auto' | 'fallback' | 'interrupt' | 'switch'
  /** 这一步在做什么，例如「主要阶段操作」 */
  title: string
  /** 决策结果：选了哪个候选 / 规划出了什么路线 */
  detail: string
  /** 模型自己给的理由 */
  reason?: string
  /** 这一步有多少个候选可选（便于判断难度） */
  candidateCount?: number
  /** 实际发给模型的 prompt（截断），用来核对它到底看到了什么 */
  request?: string
  /** 模型原始返回，未经解析 */
  raw?: string
  latencyMs: number
  retries: number
  tokens?: AgentTokens
}

export interface AgentStats {
  calls: number
  retries: number
  fallbacks: number
  failures: number
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
}

export interface AgentDeps {
  config: AiConfig
  nameOf: (code: number) => string
  describe: (descriptionId: number) => string
  /** 卡库效果摘要：选卡 / 检索时模型要据此判断选哪张 */
  summary?: (code: number) => string
  /** 懒加载：skill 包可能还没生成 */
  getSkill: () => SkillSource | null
  /** 实时事件流，用于识别打断 */
  getSignals: () => DuelSignal[]
  deck: () => { name: string; mainNames: string[]; extraNames: string[] }
  onStatus?: (status: AgentStatus, note?: string) => void
  onTrace?: (entry: AgentTrace) => void
  onReason?: (text: string) => void
}

const READ_SKILL: AiTool = {
  name: 'read_skill',
  description: '读取本卡组 skill 知识库的某个分片（展开路线 / 卡效 / 手坑应对）。id 取自索引里的条目。',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: '分片 id，例如 20-replay-01 或 cards/89631139' } },
    required: ['id'],
  },
}

export class AgentRunner {
  private plan: Plan | null = null
  private answered = new WeakSet<object>()
  /** 已经执行过的 plan.steps 下标，防止同一条被反复确定性执行 */
  private usedSteps = new Set<number>()
  /**
   * 路线里已经真正做过的动作卡名。
   *
   * 按卡名记而不是按步骤下标：一条步骤常写几张卡（「通召 X，特召 Y 做 Z」），
   * 做掉其中一张就把整步标成「已执行」，会让还没用到的卡在候选上被标成
   * 「（已执行）」，模型据此跳过了本该做的动作。
   */
  private usedNames = new Set<string>()
  /** 最近一次真正发给模型的 prompt 与原始返回（日志用） */
  private lastRequest = ''
  private lastRaw = ''
  private history: string[] = []
  private signalCursor = 0
  private interruption = ''
  /** 路线连续对不上局面的次数：累计到阈值就认为路线脱离实际，触发重规划 */
  private unmatched = 0
  /**
   * 本回合规划失败过的回合数。
   *
   * 失败后如果每个提问都重试一次，会白烧十几秒和几万 token；而且那时盘面已经推进，
   * 拿变化后的手牌去规划，很容易得出「没有启动点」的兜底路线，把好好的展开废掉。
   */
  private planFailedTurn: number | null = null
  private stats: AgentStats = emptyStats()
  private busy = false
  private stopped = false

  constructor(private readonly deps: AgentDeps) {}

  stop() {
    this.stopped = true
  }

  getStats(): AgentStats {
    return { ...this.stats }
  }

  getPlan(): Plan | null {
    return this.plan
  }

  /**
   * 重新接管。
   *
   * 刻意**保留路线与已执行步骤**：手动打了几步不代表整条路线作废，
   * 只要没检测到偏离（见 `planExhausted` / 打断 / 跨回合），就继续照原路线走。
   * 统计也保留——「暂停 → 继续」是同一局，成本要累计。
   */
  reset() {
    this.history = []
    // 只把暂停之后新出现的信号视为打断：从头重扫会把历史连锁误判成新打断
    this.signalCursor = this.deps.getSignals().length
    this.interruption = ''
    this.unmatched = 0
    this.busy = false
    this.stopped = false
    this.answered = new WeakSet<object>()
  }

  /** 当前是否还沿用一条路线（供界面显示「继续沿用 / 已重新规划」） */
  hasPlan(): boolean {
    return Boolean(this.plan)
  }

  /**
   * 处理一个提问。
   *
   * 去重不能用「见过就跳过」：内核 RETRY 时会把**同一个提问对象**重新抛出来，
   * 跳过就永远答不上，界面表现为卡死。所以这里区分两件事：
   *   busy     —— 上一次还在算，重复触发的 emit 直接忽略
   *   answered —— 已经提交过答案，再次出现说明是 RETRY，允许重算
   */
  async handle(
    question: DuelQuestion,
    state: DuelStateView,
    answer: (response: OcgResponse) => boolean,
  ): Promise<void> {
    if (this.stopped || this.busy) return
    if (this.answered.has(question)) this.answered.delete(question)
    this.busy = true
    // 再让出一次微任务：同步作答的路径不能抢在内核挂上等待之前提交
    await Promise.resolve()

    try {
      this.scanSignals()
      if (this.plan && state.turn !== this.plan.turn) {
        // 跨回合：上一条路线只在它被规划的那个回合有效
        this.trace({
          kind: 'switch',
          title: '路线过期',
          detail: `进入第 ${state.turn} 回合，上一条路线不再适用`,
        })
        this.plan = null
        this.usedSteps.clear()
        this.usedNames.clear()
      }

      const candidates = enumerateCandidates(question, {
        nameOf: this.deps.nameOf,
        describe: this.deps.describe,
        summary: this.deps.summary,
      })
      this.tagRoles(candidates)

      // 确定性段：没有岔路（选卡 / 解放 / 数值 / 格位）交给沙包策略，不消耗 token
      if (!candidates.length) {
        this.apply(question, answer, autoRespond(question), 'auto', `${questionLabel(question)}：确定性策略`)
        return
      }
      if (candidates.length === 1) {
        this.apply(question, answer, candidates[0].response, 'auto', `${questionLabel(question)}：唯一候选`)
        return
      }

      // 「必须全选」的多选没有决策空间（例如可解放数正好等于解放数），直接作答
      const selection = answerPlan(question)
      if (selection?.mode === 'multi' && !selection.cancel) {
        const selectable = candidates.filter((item) => item.pick !== undefined)
        if (selectable.length === selection.min) {
          const response = buildAnswerResponse(
            question,
            candidates,
            selectable.map((item) => item.id),
          )
          if (response) {
            this.apply(question, answer, response, 'auto', `${questionLabel(question)}：只能全选`)
            return
          }
        }
      }

      /**
       * 规划时机：不再等 `idle`。
       *
       * 这套构筑的展开从抽卡阶段就开始（丢弃栗球兽卫 → 盖两颗心灵 → 检索 → 发动墓地效果），
       * 等到主要阶段才规划时，前面的连锁早已经按「没有路线」的单步直觉打完了，
       * 后面的 plan 也接不上前面打出来的场面。所以只要轮到我方决策、手上还没有路线就规划。
       */
      const needPlan =
        this.deps.config.planOnStart &&
        (!this.plan || Boolean(this.interruption) || this.planExhausted() || this.unmatched >= MAX_UNMATCHED) &&
        // 本回合刚失败过就不再重试；被对手打断时允许立刻重新规划
        (Boolean(this.interruption) || this.planFailedTurn !== state.turn)

      if (needPlan && state.turnPlayer === 0 && question.player === 0) {
        const reason = !this.plan
          ? '还没有路线'
          : this.interruption ||
            (this.unmatched >= MAX_UNMATCHED
              ? `路线连续 ${this.unmatched} 步对不上局面`
              : '路线上点名的资源已经用完')
        try {
          await this.planRoute(state, Boolean(this.plan), reason)
        } catch (error) {
          // 规划失败不该让整个回合空过：记一笔，退到「没有路线」的单步决策
          this.stats.failures += 1
          this.plan = null
          this.usedSteps.clear()
          this.usedNames.clear()
          this.deps.onStatus?.('thinking', `规划失败，改为单步决策：${error instanceof Error ? error.message : ''}`)
        }
      }

      // 沿路线执行：规划里明确写到的动作能唯一对上候选时，不再问模型
      const matched = this.matchPlanStep(question, candidates, selection)
      if (matched) {
        const response = buildAnswerResponse(
          question,
          candidates,
          matched.map((item) => item.id),
        )
        if (response) {
          const text = matched.map((item) => item.text).join(' + ')
          this.unmatched = 0
          // 记成 decide 而不是 auto：这是「照路线走」的关键动作，日志里要默认可见
          this.apply(question, answer, response, 'decide', `沿路线执行（未调模型）：${text}`)
          return
        }
      }

      /**
       * 路线在手且没被打断：剩下的岔路本地答完，绝不为一步操作再发一次请求。
       *
       * 但效果分支（`option`）例外——候选只有「伤害改变 / 盖放魔陷」这种脱离卡名的名字，
       * 本地既对不上路线也没法判断收益，`autoRespond` 又固定选第一项，
       * 正是「该盖两颗心灵却选了伤害改变」的原因。这类提问一律交给模型。
       */
      if (this.plan && !this.interruption && question.kind !== 'option') {
        const local = this.executeRoute(question, candidates, selection)
        if (local.matched) {
          this.unmatched = 0
          this.apply(question, answer, local.response, 'decide', local.text)
          return
        }
        // 取牌有歧义不算「路线对不上」，别拿它攒重规划次数
        if (!local.defer) this.unmatched += 1
        /**
         * 路线没覆盖时，这两类提问**不能**本地拍板：
         *
         * - `idle`：`autoRespond` 会直接「结束回合」，一次误判就把整个主要阶段送掉；
         * - `chain`：`autoRespond` 会「放弃响应」，正好把该接的连锁（神镜 / 草那艺）掐断。
         *
         * 路线只有十几步，末尾往往写成「通召 X → 出 Y → 做 Z」这种概括，
         * 拿它当唯一依据等于「路线没写到的部分一律不做」。交给模型，它至少能看到
         * 局面、候选和录像标注，不会把还能做的事当成收尾。
         */
        if (!local.defer && question.kind !== 'idle' && question.kind !== 'chain') {
          this.apply(question, answer, local.response, 'fallback', local.text)
          return
        }
      }

      // 只有「还没有路线」或「刚被打断、新路线还没拿到」才单步问模型
      const picked = await this.decide(question, state, candidates)
      // 没有路线时 unmatched 没有意义；有路线时保留计数，让「连续对不上」仍能触发重规划
      if (!this.plan) this.unmatched = 0
      this.apply(question, answer, picked.response, 'decide', picked.text)
    } catch (error) {
      // 模型层出错不能卡住对局：退到确定性策略，把失败计入统计
      this.stats.failures += 1
      this.deps.onStatus?.('error', error instanceof Error ? error.message : String(error))
      this.apply(question, answer, autoRespond(question), 'fallback', '模型调用失败，降级为确定性策略')
    } finally {
      this.busy = false
      this.deps.onStatus?.('idle')
    }
  }

  private apply(
    question: DuelQuestion,
    answer: (response: OcgResponse) => boolean,
    response: OcgResponse,
    kind: 'auto' | 'decide' | 'fallback',
    detail: string,
  ) {
    const title = questionLabel(question)
    // 这些条目没有模型参与，不要把上一次的请求/返回挂上来
    const io = { request: '', raw: '' }
    // 用户已经点「接管回来」，算出来的答案直接丢弃
    if (this.stopped) {
      this.trace({ kind, title, detail: `${detail}（AI 已关闭，丢弃）`, ...io })
      return
    }
    if (answer(response)) {
      this.answered.add(question)
      // 沿路线执行也算「AI 做了决定」，界面上要能看到它照路线走了
      if (kind !== 'auto' || detail.startsWith('沿路线执行')) this.deps.onReason?.(detail)
      this.trace({ kind, title, detail, ...io })
      return
    }
    // 内核已经不在等这一步（重复 emit / 面板残留）
    this.trace({ kind, title, detail: `${detail}（内核未在等待，已丢弃）`, ...io })
  }

  /**
   * 沿路线执行：把 plan.steps 的自然语言条目对上当前候选。
   *
   * 保守原则——动作词与卡名都命中、且只命中一个候选时才执行。
   * 「通召 A」不会匹配到「盖放 A」，「检索 B」不会命中任何候选（检索属于选卡提问，
   * 不在这套枚举里）。匹配不上时交给 `executeRoute()` 本地裁定，不再问模型。
   */
  private matchPlanStep(
    question: DuelQuestion,
    candidates: Candidate[],
    plan: AnswerPlan | null,
  ): Candidate[] | null {
    const steps = this.plan?.steps ?? []
    if (!steps.length || !plan) return null

    if (plan.mode === 'single') {
      if (question.kind !== 'idle' && question.kind !== 'battle') return null
      for (let index = 0; index < steps.length; index += 1) {
        if (this.usedSteps.has(index)) continue
        // 模型常写「通召 / 特召」，候选文本用的是「召唤 / 特殊召唤」，先归一化
        const step = steps[index].replace(/通召/g, '召唤').replace(/特召/g, '特殊召唤')
        const hits = candidates.filter((item) => {
          // 长词优先：『特殊召唤』同时包含『召唤』
          const action = ACTION_WORDS.find((word) => item.text.startsWith(word))
          if (!action) return false
          const name = CARD_NAME.exec(item.text)?.[1]
          return Boolean(name && step.includes(name) && step.includes(action))
        })
        if (hits.length === 1) {
          this.usedSteps.add(index)
          return [hits[0]]
        }
      }
      return null
    }

    // 多选：只放行「从卡组 / 额外卡组取牌」。
    // 检索错一张会毁掉整条路线，而目标本来就写在 plan 里；
    // 弃手卡 / 解放场上的卡这类 cost 不在此列，继续交给模型判断。
    const searchable = candidates.filter(
      (item) =>
        item.pick !== undefined &&
        (item.location === OcgLocation.DECK || item.location === OcgLocation.EXTRA),
    )
    if (!searchable.length) return null
    const mentioned = this.namesInText(steps.join('\n'))
    if (!mentioned.size) return null
    const picks = searchable
      .filter((item) => {
        const name = CARD_NAME.exec(item.text)?.[1]
        return Boolean(name && mentioned.has(name))
      })
      // 起手卡和检索目标常常同时被点名：按路线顺序排，别让候选列表的顺序决定拿谁
      .sort((a, b) => this.stepRank(nameIn(a.text)) - this.stepRank(nameIn(b.text)))
    // 命中多张 = 有歧义。检索错一张后面整条链全断，交给模型判，不在这里猜
    if (picks.length > 1) return null
    // 数量正好落在内核允许的区间才执行：多了少了都交给本地执行器裁定
    if (picks.length < plan.min || picks.length > plan.max) return null
    return picks.slice(0, plan.min)
  }

  /**
   * 执行段：路线已确定且没被打断时，剩下的岔路全部本地答完。
   *
   * 用户要的就是「路线定了直接打，被打断才叫 AI 重新想」，所以这里宁可走保守策略，
   * 也不为一张解放卡 / 一次弃手卡再发一次请求。对不上路线的次数由 `unmatched`
   * 累计，够 `MAX_UNMATCHED` 次就在下一次 idle 触发重规划，避免一路瞎打到底。
   */
  private executeRoute(
    question: DuelQuestion,
    candidates: Candidate[],
    plan: AnswerPlan | null,
  ): { response: OcgResponse; text: string; matched: boolean; defer?: boolean } {
    const label = questionLabel(question)
    if (!plan) {
      return { response: autoRespond(question), text: `${label}：确定性策略`, matched: true }
    }

    // 路线里点名要用的我方卡：连锁 / 是否发动这类提问按卡名对
    const named = this.planTextNames()

    /**
     * 「是否发动效果」：候选只有「是 / 否」，卡名只能从提问本身拿。
     *
     * 这类提问必须按路线判——路线写到「发动混沌恶魔的墓地效果」，这里就不能答否，
     * 否则取完牌链路就断在这一步（`autoRespond` 对效果确认固定答「否」）。
     */
    if (plan.mode === 'single' && question.kind === 'yesno' && question.message.type === OcgMessageType.SELECT_EFFECTYN) {
      const message = question.message
      const name = this.deps.nameOf(message.code)
      const zone = zoneLabel(message.location, message.sequence)
      const yes = candidates.find((item) => item.text === '是')
      if (yes && named.has(name)) {
        return {
          response: yes.response,
          text: `沿路线执行（未调模型）：发动「${name}」（${zone}）`,
          matched: true,
        }
      }
    }

    if (plan.mode === 'single') {
      if (named.size) {
        const hits = candidates.filter((item) => {
          const name = CARD_NAME.exec(item.text)?.[1]
          return Boolean(name && named.has(name))
        })
        if (hits.length === 1) {
          this.consumeStep(hits[0].text)
          return { response: hits[0].response, text: `沿路线执行（未调模型）：${hits[0].text}`, matched: true }
        }
      }
      // 路线没覆盖：连锁放弃响应最省资源，主要阶段则收尾（进战阶 / 结束回合）
      return { response: autoRespond(question), text: `${label}：路线未覆盖，按确定性策略收尾`, matched: false }
    }

    const selectable = candidates.filter((item) => item.pick !== undefined)
    if (!selectable.length) {
      return { response: autoRespond(question), text: `${label}：确定性策略`, matched: true }
    }

    const chosen = selectable
      .filter((item) => {
        const name = CARD_NAME.exec(item.text)?.[1]
        return Boolean(name && named.has(name))
      })
      // 同上：`named` 只说明「路线里提到过」，拿谁要按路线进度排
      .sort((a, b) => this.stepRank(nameIn(a.text)) - this.stepRank(nameIn(b.text)))
    /**
     * 命中多张就是歧义（例如卡组里同时躺着「巳剑之尊 麁正」和「天丛云之巳剑」）。
     *
     * 取牌是整条链最贵的一步：检索错一张，后面所有步骤全部作废——日志里
     * 「两颗心灵检索了栗球兽卫」和「巳剑劝请拿了天丛云而不是麁正」都是这么来的。
     * 这时把选择权交回模型（候选带数量编号与录像标注），别用启发式猜。
     */
    if (chosen.length > 1 && chosen.length >= plan.min) {
      /**
       * 只有「步骤号并列」才交给模型。
       *
       * 候选上已经标着〔路线第 N 步〕：路线明确指定了唯一的最小步骤时
       * （第 6 步取巳剑降临、第 8 步才轮到巳剑劝请），这里直接取。
       * 交给模型反而出错——日志里它自己的理由写「应选编号 2」，action 却给了 1，
       * 取错一张，整条巳剑线当场废掉。
       */
      const ranks = chosen.map((item) => this.stepRank(nameIn(item.text)))
      const best = Math.min(...ranks)
      const bestPicks = chosen.filter((_, index) => ranks[index] === best)
      // 同名卡的多张副本不算并列，按卡名去重后只有一个才算路线已明确指定
      const bestNames = new Set(bestPicks.map((item) => nameIn(item.text)))
      if (best < Number.MAX_SAFE_INTEGER && bestNames.size === 1 && bestPicks.length >= plan.min) {
        const picks = bestPicks.slice(0, plan.min)
        const response = buildAnswerResponse(
          question,
          candidates,
          picks.map((item) => item.id),
        )
        if (response) {
          picks.forEach((item) => this.consumeStep(item.text))
          return {
            response,
            text: `沿路线取牌（未调模型）：${picks.map((item) => item.text).join(' + ')}`,
            matched: true,
          }
        }
      }
      return { response: autoRespond(question, { lenient: true }), text: '', matched: false, defer: true }
    }
    const rest = selectable
      .filter((item) => !chosen.includes(item))
      .sort((a, b) => sacrifice(a) - sacrifice(b))
    const picks = [...chosen, ...rest].slice(0, plan.min)
    const response = buildAnswerResponse(
      question,
      candidates,
      picks.map((item) => item.id),
    )
    if (!response) {
      // 组合没法拼（数量不够等）：退到内核的最小合法选择，别把流程卡死
      return { response: autoRespond(question, { lenient: true }), text: `${label}：确定性策略`, matched: false }
    }
    picks.forEach((item) => this.consumeStep(item.text))
    return {
      response,
      text: `沿路线取牌（未调模型）：${picks.map((item) => item.text).join(' + ')}`,
      matched: chosen.length > 0,
    }
  }

  /**
   * 给候选打角色标：`连锁发动「栗球兽卫」` → `连锁发动「栗球兽卫」〔启动点〕`。
   *
   * 只靠 system 里的 brief 不够——模型常在候选文本里就地判断「这张卡能不能白嫖一次」。
   * 标在候选上，它就不会把唯一启动点当成一张可随手丢掉的阻抗。
   */
  private tagRoles(candidates: Candidate[]) {
    const roles = this.deps.getSkill()?.roles
    if (!roles) return
    const roleOf = (name: string): string => {
      if (roles.starters.includes(name)) return '启动点'
      if (roles.handtraps.includes(name)) return '手坑'
      if (roles.bricks.includes(name)) return '废件'
      return ''
    }
    for (const item of candidates) {
      const name = CARD_NAME.exec(item.text)?.[1]
      if (!name) continue
      const role = roleOf(name)
      if (role) item.text = `${item.text}〔${role}〕`
    }
  }

  /** plan 里点名要用的卡（用卡表卡名匹配，避免只认带「」的写法） */
  private namesInText(text: string): Set<string> {
    if (!text) return new Set()
    const deck = this.deps.deck()
    const names = [...deck.mainNames, ...deck.extraNames].filter(
      (name) => name.length >= 2 && text.includes(name),
    )
    return new Set(names)
  }

  /**
   * 路线里点名要用的卡：只取「目标 + 步骤」。
   *
   * `avoid` 放进去会把「别用」的卡当成要做的事；`handtraps` 里常写着对手的卡名
   * （「对手灰流丽」），而我方手上也可能正好有同名卡，放进去会误连锁发动。
   */
  private planTextNames(): Set<string> {
    const plan = this.plan
    if (!plan) return new Set()
    return this.namesInText([plan.goal, ...plan.steps].join('\n'))
  }

  /**
   * 路线里某个卡名的优先度，越小越该先拿。
   *
   * 只判断「在不在这条路线里」是不够的：起手卡（栗球兽卫）和检索目标（混沌恶魔）
   * 会同时出现在 steps 里，按候选列表顺序取第一个，就成了「两颗心灵检索栗球兽卫」——
   * 检索目标一错，后面整条链全断。按「未执行的步骤顺序」排才是路线本身的意思。
   */
  private stepRank(name: string): number {
    if (!name) return Number.MAX_SAFE_INTEGER
    const steps = this.plan?.steps ?? []
    let best = Number.MAX_SAFE_INTEGER
    for (let index = 0; index < steps.length; index += 1) {
      if (!steps[index].includes(name)) continue
      // 已经做过的卡排在所有没做过的之后
      const rank = this.usedNames.has(name) ? 100 + index : index
      if (rank < best) best = rank
    }
    return best
  }

  /** 记下路线里已经真正做过的动作（按卡名，同一一步里的其它卡不受影响） */
  private consumeStep(text: string) {
    const name = nameIn(text)
    if (name) this.usedNames.add(name)
  }

  /* ---------------------------------------------------------------- */
  /* 打断检测                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 只看「新出现」的信号。
   * 对手开连锁 / 我方效果被无效，都说明原路线的前提变了。
   */
  private scanSignals() {
    const signals = this.deps.getSignals()
    for (let index = this.signalCursor; index < signals.length; index += 1) {
      const signal = signals[index]
      if (signal.kind === 'chain' && signal.player === 1) {
        this.interruption = `对手发动「${signal.name || signal.code}」`
        this.trace({ kind: 'interrupt', title: '检测到打断', detail: this.interruption })
      } else if (signal.kind === 'negated') {
        this.interruption = `我方第 ${signal.chainSize} 条连锁被无效`
        this.trace({ kind: 'interrupt', title: '检测到打断', detail: this.interruption })
      }
    }
    this.signalCursor = signals.length
  }

  /**
   * 路线前提是否已经失效。
   *
   * 保守判定：只有「plan 里点名要用的卡已经全部进墓地 / 除外」才算偏离。
   * 正常展开时这些卡会陆续上场或留在手卡，不会触发；手动操作把资源打光才会。
   * 卡组内容不可见，所以用信号流重建每张卡最后一次的落点。
   */
  private planExhausted(): boolean {
    const plan = this.plan
    if (!plan) return false
    const text = [plan.goal, ...plan.steps].join('\n')
    if (!text.trim()) return false
    const deck = this.deps.deck()
    const mentioned = [...deck.mainNames, ...deck.extraNames].filter(
      (name) => name.length >= 2 && text.includes(name),
    )
    if (!mentioned.length) return false
    const zones = this.cardZones(this.deps.getSignals())
    const alive = mentioned.some((name) => {
      const zone = zones.get(name)
      // 从没被移动过：还在起始区域（手卡 / 卡组 / 额外）
      if (zone === undefined) return true
      return (zone & (OcgLocation.GRAVE | OcgLocation.REMOVED)) === 0
    })
    return !alive
  }

  /** 从信号流重建「每张卡最后落在哪个区域」 */
  private cardZones(signals: DuelSignal[]): Map<string, number> {
    const zones = new Map<string, number>()
    for (const signal of signals) {
      if (!signal.name) continue
      if ((signal.kind === 'move' || signal.kind === 'set') && signal.to) {
        zones.set(signal.name, signal.to.location)
      }
    }
    return zones
  }

  /* ---------------------------------------------------------------- */
  /* 路线规划                                                          */
  /* ---------------------------------------------------------------- */

  private async planRoute(state: DuelStateView, replan: boolean, reason = '') {
    this.deps.onStatus?.('planning')
    const started = Date.now()
    const mark = this.mark()
    const skill = this.deps.getSkill()
    const deck = this.deps.deck()
    const hand = state.players[0].hand.map((card) => (card.hidden ? '未知卡' : card.name))
    /**
     * 起手命中的录像路线直接放进规划 prompt。
     *
     * 索引里只写着「这条起手该读 20-replay-01.md」，模型不一定真去读；
     * 而路线就是这套卡组的实际打法，丢给模型一条与它无关的自由发挥路线，
     * 后面按路线执行时必然步步对不上。所以这里把完整步骤摆出来。
     */
    const replayRoute = pickReplayRoute(skill, [
      ...hand.filter((name) => name !== '未知卡'),
      ...state.chain.map((item) => item.name),
    ])
    const replayText = replayRoute
      ? [
          `录像 ${replayRoute.code}｜起手：${replayRoute.opening.join('、') || '未知'}`,
          ...replayRoute.steps.map((step, index) => `${index + 1}. ${step}`),
          // 「丢弃 1 张手卡」「选择一张卡」具体选谁，录像的取牌记录是唯一依据
          replayRoute.picks?.length ? `录像里这次实际选中的卡：${replayRoute.picks.slice(0, 20).join('、')}` : '',
          replayRoute.options?.length ? `录像里效果分支选了：${replayRoute.options.slice(0, 12).join('、')}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : ''

    const board = renderBoard(state)
    /**
     * 路线会碰到的卡的效果原文。
     *
     * 只给卡名清单 + skill 索引时，模型不会主动 `read_skill`（43 份分片摆着也不读），
     * 而是按卡名联想效果——「墓地 3 张卡回卡组」这类幻觉正是从这里来的。
     * 起手 / 录像步骤 / 录像实际选中 / 当前场面里出现的卡，效果原文一次带进去，
     * 一次规划多 2~3k token，换掉整条路线的效果错误。
     */
    const cardEffects = cardEffectsFor(skill, [
      /**
       * 录像分片是整局的（这份 134 步 / 2 回合），把 36 步全拿来抠卡名，
       * 第 2 回合黑魔女线（神圣蓟花 / 告死圣徒 / 罪宝狩猎之恶魔）会把预算吃满，
       * 本回合要用的巳剑线一张都进不来。只取前 PLAN_CARD_STEPS 步。
       */
      ...(replayRoute ? namesIn(replayRoute.steps.slice(0, PLAN_CARD_STEPS).join('\n')) : []),
      ...(replayRoute ? replayRoute.picks : []),
      ...(replayRoute ? namesIn(replayRoute.options.join('\n')) : []),
      // 起手只算启动点：手坑 / 废件的效果对展开没有信息量，却会按字数额度挤掉关键卡
      ...hand.filter((name) => name !== '未知卡' && skill?.roles.starters.includes(name)),
      ...namesIn(board),
    ])
    const input = {
      deckName: deck.name,
      handNames: hand,
      deckNames: deck.mainNames,
      extraNames: deck.extraNames,
      skillIndex: skill?.index ?? '',
      skillBudget: this.deps.config.skillBudget,
      replay: replayText,
      cardEffects,
      /**
       * 盘面与最近操作必须一起给。
       *
       * 抽卡阶段第一条连锁打完后手卡里的启动卡已经没了，只给手牌，模型会判成
       * 「这套起手没有启动点」→ 规划出一条兜底路线 → 执行段把录像的后续步骤
       * 全当成「路线未覆盖」放弃，展开就断在这里。
       */
      board,
      history: this.history.filter((line) => !line.startsWith('[规划]')),
    }

    const messages = replan
      ? buildReplanMessages({
          ...input,
          previous: this.plan,
          interruption: reason || this.interruption,
        })
      : buildPlanMessages(input)

    let retries = 0
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.lastRequest = this.promptText(messages)
        const result = await this.complete(messages, 'plan')
        this.lastRaw = this.rawText(result.content)
        const parsed = parseJsonObject(result.content)
        if (parsed) {
          this.plan = parsePlan(parsed, state.turn)
          this.usedSteps.clear()
          this.usedNames.clear()
          break
        }
        // 截断和「写了废话」的补救方式不一样：截断必须让它压缩输出，而不是重说一遍
        const truncated = result.finishReason === 'length'
        messages.push({
          role: 'user',
          content: truncated
            ? '上次输出被 max_tokens 截断，json 不完整。请重写：steps 只留最关键的 8 条、每条不超过 30 字，goal 一句话，avoid 与 handtraps 各 3 条以内。'
            : result.content.trim()
              ? '上次输出不是合法 json。请只输出一个 json 对象，不要任何解释。'
              : '上次输出是空的。请只输出一个 json 对象，不要解释。',
        })
      } catch (error) {
        // 请求级失败也要能再试一次，不能一次 400 就把整个回合判死
        const reason = this.noteError(error)
        messages.push({ role: 'user', content: `上次请求失败（${reason}）。请重新输出一个 json 对象。` })
      }
      retries += 1
      this.stats.retries += 1
    }

    this.interruption = ''
    this.unmatched = 0
    // 本回合规划成功过就不再拦；失败则记住，避免每个提问都重试一次（十几秒 + 几万 token）
    this.planFailedTurn = this.plan ? null : state.turn
    if (this.plan) {
      this.history.push(`[规划] ${renderPlan(this.plan).slice(0, 160)}`)
      // skill 是否读到，直接决定这次规划靠的是路线还是模型常识，必须写在日志里
      const skillLine = skill
        ? `skill 分片 ${skill.sections.length} 条`
        : '⚠ 没有读到 skill（展开未匹配到当前卡组），本次只能凭模型常识规划'
      this.trace({
        kind: replan ? 'replan' : 'plan',
        title: replan ? '重新规划路线' : '起手规划路线',
        detail: [reason ? `触发原因：${reason}` : '', skillLine, renderPlan(this.plan)]
          .filter(Boolean)
          .join('\n'),
        latencyMs: Date.now() - started,
        retries,
        tokens: this.since(mark),
      })
    } else {
      this.trace({
        kind: 'fallback',
        title: '规划失败',
        detail: '两次都没拿到合法路线，改为单步决策',
        latencyMs: Date.now() - started,
        retries,
        tokens: this.since(mark),
      })
    }
    this.deps.onStatus?.('thinking')
  }

  /* ---------------------------------------------------------------- */
  /* 单步决策                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 提问标题。
   *
   * 「选择效果分支」这类选项只给「伤害改变 / 盖放魔陷」，脱离卡名看毫无意义——
   * 模型根本不知道这是谁的效果。连锁上正在处理的那张卡就是答案，顺手写进标题。
   */
  private labelFor(question: DuelQuestion, source: string): string {
    const label = questionLabel(question)
    if (question.kind === 'option') {
      return source ? `${label}（正在处理「${source}」的效果）` : label
    }
    /**
     * 「是否发动效果」只给「是 / 否」两个候选。不说是谁的效果时，模型看到
     * 「墓地 1 张、手卡全是手坑」就会判成「没有收益」而放弃——混沌恶魔的墓地效果
     * 就是这样被答否的。提问本身带卡号 / 区域 / 效果分条，直接摊开给它。
     */
    if (question.kind === 'yesno' && question.message.type === OcgMessageType.SELECT_EFFECTYN) {
      const message = question.message
      const name = this.deps.nameOf(message.code)
      const zone = zoneLabel(message.location, message.sequence)
      const text = this.deps.describe(Number(message.description)).replace(/\s+/g, ' ').trim().slice(0, 60)
      return `${label}：「${name}」（${zone}）${text ? `｜${text}` : ''}`
    }
    return label
  }

  /**
   * 候选卡在路线里的位置：`〔路线第 N 步〕`。
   *
   * 多选取牌时模型容易把「后面某一步要检索的卡」当成当前该拿的卡
   * （日志里出现过 reason 说选 2、action 却给了 1）。把步骤号直接印在候选上，
   * 「编号小且没标已执行」就成了显式规则，不用它自己在脑子里排。
   */
  private planStepLabel(text: string): string {
    const plan = this.plan
    if (!plan) return ''
    const name = nameIn(text)
    /**
     * 卡名优先；没有卡名（效果分支的「从手卡仪式召唤 / 从卡组仪式召唤」）就退回用
     * 候选文本本身去找——路线里这两种分支写在不同的步骤上，步骤号能直接分出先后。
     */
    const probe = name || text.replace(/〔[^〕]*〕/g, '').replace(/^★/, '').trim()
    if (probe.length < 2) return ''
    for (let index = 0; index < plan.steps.length; index += 1) {
      if (!plan.steps[index].includes(probe)) continue
      const done = name ? this.usedNames.has(name) : false
      return done ? `路线第 ${index + 1} 步（已执行）` : `路线第 ${index + 1} 步`
    }
    return ''
  }

  /**
   * 路线的局部进度窗口。
   *
   * 决策 prompt 原来塞整条 plan（20 步约 1500 字），模型得自己在里面找「现在该做第几步」——
   * 那是让它做指针运算，「路线第 7 步写的是从手卡，它记成从卡组」就是这么错的。
   * 这里压成「刚做完 / 现在这一步 / 接下来两步」，并且把编号和候选上的〔路线第 N 步〕对齐。
   */
  private planFocus(context: string[] = []): PlanFocus | null {
    const plan = this.plan
    if (!plan || !plan.steps.length) return null
    const total = plan.steps.length
    /** 这一步是否已经做完：显式标过，或步骤里点到的卡全部消费过 */
    const finished = (index: number): boolean => {
      if (this.usedSteps.has(index)) return true
      const names = namesIn(plan.steps[index])
      return names.length > 0 && names.every((name) => this.usedNames.has(name))
    }
    let current = -1
    /**
     * 优先按「当前正在处理的卡」定位。
     *
     * 光按 finished 往后推不可靠：一条步骤常写好几张卡，而「盖放『两颗心灵』」这类动作
     * 由「盖放魔陷」这个效果分支完成，候选文本里根本没有卡名，`consumeStep` 永远拿不到它，
     * 进度就永久卡在第 1、2 步——日志里已经打到第 8 步，prompt 还在说「现在这一步（第 2 步）」。
     * 连锁顶 / 正在处理的效果来源是确定的事实，用它找步骤最准。
     */
    for (const name of context) {
      if (!name) continue
      for (let index = 0; index < total; index += 1) {
        if (finished(index)) continue
        if (!plan.steps[index].includes(name)) continue
        current = index
        break
      }
      if (current >= 0) break
    }
    // 没有可用的焦点卡（例如不在连锁上）：退回第一个未完成的步骤
    if (current < 0) {
      for (let index = 0; index < total; index += 1) {
        if (finished(index)) continue
        current = index
        break
      }
    }
    const ref = (index: number): PlanStepRef => ({ step: index + 1, text: plan.steps[index] })
    const end = current < 0 ? total : current
    const done: PlanStepRef[] = []
    for (let index = Math.max(0, end - 2); index < end; index += 1) done.push(ref(index))
    const next: PlanStepRef[] =
      current < 0 ? [] : plan.steps.slice(current + 1, current + 3).map((_, offset) => ref(current + 1 + offset))
    return {
      route: plan.route,
      goal: plan.goal,
      total,
      done,
      current: current < 0 ? null : ref(current),
      next,
      avoid: plan.avoid,
      handtraps: plan.handtraps,
    }
  }

  /** 正在处理的效果来源：优先取连锁顶，其次取本回合最近一次发动 */
  private effectSource(state: DuelStateView): string {
    const top = state.chain[state.chain.length - 1]
    if (top?.name) return top.name
    const signals = this.deps.getSignals()
    for (let index = signals.length - 1; index >= 0; index -= 1) {
      const signal = signals[index]
      if (signal.turn !== state.turn) break
      if (signal.kind === 'chain' && signal.name) return signal.name
    }
    return ''
  }

  private async decide(
    question: DuelQuestion,
    state: DuelStateView,
    candidates: Candidate[],
  ): Promise<{ response: OcgResponse; text: string }> {
    this.deps.onStatus?.('thinking')
    const started = Date.now()
    const mark = this.mark()
    const answer = answerPlan(question)
    if (!answer) {
      return { response: autoRespond(question), text: `${questionLabel(question)}：确定性策略` }
    }

    const skill = this.deps.getSkill()
    // 效果分支只给「盖放魔陷」这种分支名：正在处理的卡也算焦点，录像路线才挑得准
    const source = question.kind === 'option' ? this.effectSource(state) : ''
    // 当前局面里所有可见卡名：手卡 + 墓地 + 当前连锁，用来把录像路线对上
    const focus = [
      ...state.players[0].hand.filter((card) => !card.hidden).map((card) => card.name),
      ...state.players[0].gy.map((card) => card.name),
      ...state.chain.map((item) => item.name),
      source,
    ]
    const replay = pickReplayRoute(skill, focus)
    // 候选对齐到「录像第 N 步」：单选是选动作，多选是拿哪张卡——取牌取错一样断链
    const aligned = alignReplaySteps(candidates, replay)
    /**
     * 效果分支里「录像选过」的候选。
     *
     * 录像在不同场合可能分别选过「从手卡仪式召唤」和「从卡组仪式召唤」，
     * 两个候选都能匹配上——这时**不能**两个都标 ★，否则等于没给信息
     * （日志里模型就因为这个选了候选 1）。只有唯一匹配时才值得当作答案。
     */
    const optionHits =
      question.kind === 'option'
        ? candidates.filter((item) => (replay?.options ?? []).some((option) => item.text.includes(option)))
        : []
    const optionUnique = optionHits.length === 1 ? optionHits[0].id : -1
    let hinted = false
    const messages = buildDecideMessages({
      board: renderBoard(state),
      label: this.labelFor(question, source),
      answer,
      candidates: candidates.map((item) => {
        const hit = aligned.get(item.id)
        const step = this.planStepLabel(item.text)
        // 效果分支：唯一匹配才给 ★，多个都匹配时只提示「录像用过」，靠路线步骤号分先后
        const picked = item.id === optionUnique
        const triedOption = !picked && optionHits.includes(item)
        /**
         * 「选择卡片」的答案也来自录像：丢哪张手卡、检索哪张卡往往就是 combo 的关键
         * （录像是把检索上来的混沌恶魔自己丢掉，才能在墓地发动它的效果）。
         */
        const cardName = nameIn(item.text)
        const pickedCard =
          question.kind !== 'option' && cardName !== '' && (replay?.picks ?? []).includes(cardName)
        const tags = [
          picked ? '录像这里选的就是它' : '',
          triedOption ? '录像里用过这个分支' : '',
          pickedCard ? '录像里选过这张' : '',
          hit ? `录像第 ${hit.step} 步：${hit.text}` : '',
          step,
        ].filter(Boolean)
        if (tags.length) hinted = true
        // ★ 前缀让「录像选过的分支」在长候选列表里一眼可见，模型常漏看行尾的括号
        const text = tags.length ? `${picked ? '★' : ''}${item.text}〔${tags.join('｜')}〕` : item.text
        return { id: item.id, text }
      }),
      // 连锁顶 / 正在处理的效果来源是「现在做到哪一步」的确定事实
      focus: this.planFocus([state.chain[state.chain.length - 1]?.name ?? '', source]),
      history: this.history.slice(-8),
      // 还没规划时的第一次提问（常在抽卡阶段）：角色表 + 录像路线前几步
      skillBrief: [skill?.brief, pickReplayHint(skill, focus)].filter(Boolean).join('\n\n'),
      replayAligned: hinted,
    })

    let retries = 0
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let failure = ''
      try {
        this.lastRequest = this.promptText(messages)
        const result = await this.complete(messages, 'decide')
        this.lastRaw = this.rawText(result.content)
        const ids = this.pickIds(result.content, candidates.length, answer)
        const response = ids ? buildAnswerResponse(question, candidates, ids) : null
        if (response && ids) {
          const text = ids
            .map((id) => candidates.find((item) => item.id === id)?.text ?? `#${id}`)
            .join(' + ')
          this.history.push(`${questionLabel(question)} → ${text}`)
          if (this.history.length > 16) this.history.splice(0, this.history.length - 16)
          this.trace({
            kind: 'decide',
            title: questionLabel(question),
            detail: text,
            reason: this.pickReason(result.content),
            candidateCount: candidates.length,
            latencyMs: Date.now() - started,
            retries,
            tokens: this.since(mark),
          })
          return { response, text }
        }
        const parsed = parseJsonObject(result.content)
        failure = parsed
          ? '编号不合法（越界 / 重复 / 数量不符）'
          : result.content.trim()
            ? '输出不是合法 json'
            : result.finishReason === 'length'
              ? '输出被 max_tokens 截断（思考模式可能吃掉了额度）'
              : '输出是空的'
      } catch (error) {
        failure = this.noteError(error)
      }
      retries += 1
      this.stats.retries += 1
      const shape =
        answer.mode === 'single' ? '只要一个数字' : `要 ${answer.min}-${answer.max} 个编号的数组`
      messages.push({
        role: 'user',
        content: `上次输出无效（${failure}）。可选编号只有 1-${candidates.length}，${shape}，请只输出 json。`,
      })
    }

    // 两次都无效：单选退到最保守的动作；多选交给确定性策略
    // （组合猜错会白亏资源，不如按固定顺序取满足条件的前几张）
    this.stats.fallbacks += 1
    if (answer.mode === 'single') {
      const fallback =
        candidates.find((item) => item.text.includes('不发动')) ??
        candidates.find((item) => item.text.includes('结束回合')) ??
        candidates[candidates.length - 1]
      this.trace({
        kind: 'fallback',
        title: questionLabel(question),
        detail: `模型两次未给出有效动作，退回「${fallback.text}」`,
        candidateCount: candidates.length,
        latencyMs: Date.now() - started,
        retries,
        tokens: this.since(mark),
      })
      return { response: fallback.response, text: fallback.text }
    }
    // 允许放弃的提问直接放弃，比乱选安全
    if (answer.cancel) {
      const cancel = candidates.find((item) => item.pick === undefined)
      if (cancel) {
        this.trace({
          kind: 'fallback',
          title: questionLabel(question),
          detail: '模型两次未给出有效选择，放弃本次选择',
          candidateCount: candidates.length,
          latencyMs: Date.now() - started,
          retries,
          tokens: this.since(mark),
        })
        return { response: cancel.response, text: '放弃本次选择' }
      }
    }
    // 否则按「先牺牲墓地 / 卡组，最后才动场上」的顺序取够数量：
    // 前几张按内核顺序直接取，容易把已经铺好的终端当素材
    const ordered = [...candidates].sort((a, b) => sacrifice(a) - sacrifice(b))
    const picks = ordered.slice(0, answer.min)
    const response =
      picks.length >= answer.min
        ? buildAnswerResponse(
            question,
            candidates,
            picks.map((item) => item.id),
          )
        : null
    if (response) {
      this.trace({
        kind: 'fallback',
        title: questionLabel(question),
        detail: `模型两次未给出有效选择，按保守顺序取：${picks.map((item) => item.text).join(' + ')}`,
        candidateCount: candidates.length,
        latencyMs: Date.now() - started,
        retries,
        tokens: this.since(mark),
      })
      return { response, text: `${questionLabel(question)}：保守选择` }
    }
    this.trace({
      kind: 'fallback',
      title: questionLabel(question),
      detail: '模型两次未给出有效选择，降级为确定性策略',
      candidateCount: candidates.length,
      latencyMs: Date.now() - started,
      retries,
      tokens: this.since(mark),
    })
    return { response: autoRespond(question), text: `${questionLabel(question)}：确定性策略` }
  }

  /** 取模型给的理由（只用于日志展示） */
  private pickReason(text: string): string {
    const parsed = parseJsonObject(text)
    return typeof parsed?.reason === 'string' ? parsed.reason.slice(0, 120) : ''
  }

  /**
   * 把对话渲染成日志可读的文本。
   *
   * system 里的规则摘要很长，但对排查「模型看到了什么」是必需的；
   * 超长时保留头尾、掐掉中间，避免一条日志就吃掉几万字符。
   */
  private promptText(messages: AiMessage[]): string {
    const parts: string[] = []
    for (const message of messages) {
      if (message.role === 'system') parts.push(`[system]\n${message.content}`)
      else if (message.role === 'user') parts.push(`[user]\n${message.content}`)
      else if (message.role === 'assistant') parts.push(`[assistant]\n${message.content ?? ''}`)
      else parts.push(`[tool]\n${message.content}`)
    }
    const text = parts.join('\n\n')
    // 「看不懂 AI 为什么这么打」主要靠这条日志排查：留宽一点，录像路线和候选列表都在两端
    if (text.length <= 9000) return text
    return `${text.slice(0, 6000)}\n\n…（中间省略 ${text.length - 9000} 字符）…\n\n${text.slice(-3000)}`
  }

  private rawText(text: string): string {
    return text.length <= 2000 ? text : `${text.slice(0, 2000)}…`
  }

  /** 解析模型给的编号（数字或数组）；范围与去重在这里校验，数量交给 buildAnswerResponse */
  private pickIds(text: string, count: number, answer: AnswerPlan): number[] | null {
    const parsed = parseJsonObject(text)
    if (!parsed) return null
    const raw = parsed.action
    const list = Array.isArray(raw)
      ? raw.map((item) =>
          typeof item === 'number' ? item : typeof item === 'string' ? Number(item) : NaN,
        )
      : typeof raw === 'number' || typeof raw === 'string'
        ? [Number(raw)]
        : []
    if (!list.length) return null
    if (list.some((id) => !Number.isInteger(id) || id < 1 || id > count)) return null
    if (new Set(list).size !== list.length) return null
    if (answer.mode === 'single' && list.length !== 1) return null
    return list
  }

  /* ---------------------------------------------------------------- */
  /* 请求层                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * 规划阶段带 read_skill 工具（不能用 json 模式，两者一起用网关容易报 400）；
   * 决策阶段用 json 模式且不带工具，输出必须一次成型。
   *
   * 工具额度用完**不抛错**：收走 tools、要求直接输出。
   * 之前这里是「round 超过 toolRounds 就 throw」，模型读完 router 想再读两个分片
   * 就会把整次规划判死——日志里那句「上次请求失败（工具调用轮数超出上限）」就是它。
   *
   * 空白内容同样不在这里抛错：那是「这次没答对」，调用方要能重试。
   */
  private async complete(
    messages: AiMessage[],
    mode: 'plan' | 'decide',
  ): Promise<{ content: string; finishReason: string }> {
    const config = this.deps.config
    // 规划要写十几步 + 目标 + 规避 + 手坑应对，1200 token 根本不够：
    // 输出断在半截 → json 不合法 → 整条路线作废，退化成单步决策
    const options: ChatOptions =
      mode === 'plan'
        ? { thinking: config.thinking, maxTokens: Math.max(config.maxTokens, 4000) }
        : { json: config.jsonMode, thinking: false, maxTokens: config.maxTokens }
    const tools = mode === 'plan' && this.deps.getSkill() ? [READ_SKILL] : undefined

    let remaining = tools ? config.toolRounds : 0
    for (;;) {
      const toolsNow = remaining > 0 ? tools : undefined
      const result = await chat(config, messages, { ...options, tools: toolsNow })
      this.stats.calls += 1
      this.stats.promptTokens += result.usage.promptTokens
      this.stats.completionTokens += result.usage.completionTokens
      this.stats.cacheHitTokens += result.usage.cacheHitTokens
      this.stats.cacheMissTokens += result.usage.cacheMissTokens
      messages.push(result.assistant)

      if (!result.toolCalls.length) {
        return { content: result.content, finishReason: result.finishReason }
      }
      // 工具都收走了还想要工具：这不是可用输出，交给上层按「空返回」重试
      if (!toolsNow) {
        return { content: '', finishReason: 'tool_calls' }
      }

      for (const call of result.toolCalls) {
        messages.push({
          role: 'tool',
          content: this.runTool(call.name, call.arguments),
          tool_call_id: call.id,
        })
      }
      remaining -= 1
      if (remaining === 0) {
        messages.push({
          role: 'user',
          content: '工具调用次数已用完。请立刻只输出最终的 json 对象，不要再调用工具。',
        })
      }
    }
  }

  /** 把请求级失败写进状态条，并返回给 prompt 用的短原因 */
  private noteError(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error)
    this.deps.onStatus?.('error', text)
    return text.slice(0, 120)
  }

  private runTool(name: string, args: string): string {
    if (name !== READ_SKILL.name) return `未知工具：${name}`
    const parsed = parseJsonObject(args)
    const id = typeof parsed?.id === 'string' ? parsed.id : ''
    const text = readSkillSection(this.deps.getSkill(), id)
    if (!text) {
      const source = this.deps.getSkill()
      const available = source
        ? source.sections
            .filter((section) => !section.id.startsWith('cards/'))
            .map((section) => section.id)
            .join('、')
        : '（没有 skill）'
      return `没有分片「${id}」。可用：${available}`
    }
    // 单个分片过长会把上下文挤爆，也容易让模型反复读同一片
    return text.length > TOOL_TEXT_LIMIT
      ? `${text.slice(0, TOOL_TEXT_LIMIT)}\n…（分片过长，已截断；全文 ${text.length} 字）`
      : text
  }

  private trace(
    entry: Omit<AgentTrace, 'at' | 'latencyMs' | 'retries'> & { latencyMs?: number; retries?: number },
  ) {
    // 需要看请求/返回的条目自动带上最近一次真实调用；其余条目显式传空覆盖
    const io =
      entry.kind === 'decide' || entry.kind === 'plan' || entry.kind === 'replan' || entry.kind === 'fallback'
        ? { request: this.lastRequest, raw: this.lastRaw }
        : {}
    this.deps.onTrace?.({ at: Date.now(), latencyMs: 0, retries: 0, ...io, ...entry })
  }

  /** 记一次统计快照，用来算「这一步花了多少 token」 */
  private mark(): AgentStats {
    return { ...this.stats }
  }

  private since(mark: AgentStats): AgentTokens {
    return {
      calls: this.stats.calls - mark.calls,
      prompt: this.stats.promptTokens - mark.promptTokens,
      completion: this.stats.completionTokens - mark.completionTokens,
      cacheHit: this.stats.cacheHitTokens - mark.cacheHitTokens,
    }
  }
}

const ACTION_WORDS = ['额外卡组特召', '特殊召唤', '召唤', '连锁发动', '发动']
const CARD_NAME = /「([^」]+)」/
const CARD_NAME_ALL = /「([^」]+)」/g

function nameIn(text: string): string {
  return CARD_NAME.exec(text)?.[1] ?? ''
}

/** 抠出文本里所有 `「…」`：一条路线步骤常常同时点到好几张卡 */
function namesIn(text: string): string[] {
  return [...text.matchAll(CARD_NAME_ALL)].map((match) => match[1])
}

/** 连续多少步对不上路线就认为路线脱离实际，触发一次重规划 */
const MAX_UNMATCHED = 3

/**
 * 规划阶段注入卡效时，从录像里取前多少步的卡名。
 *
 * 规划产出的路线一般 12~15 步、对应录像的一个回合；再往后是第 2 回合的另一条
 * 展开线（这份录像后半段走的是黑魔女 / 罪宝），把它的卡效塞进 prompt 只会占预算。
 */
const PLAN_CARD_STEPS = 14

/**
 * 单次 read_skill 返回的字符上限。
 *
 * 录像分片（展开流程 + 决策序列 + 手坑表）一份展开大约 5~8 KB，压到 6000
 * 会把主要阶段后半截掉——模型照着半条路线规划，自然复现不完整。
 */
const TOOL_TEXT_LIMIT = 12000

/** 被迫取舍时先牺牲哪一区：墓地 > 卡组 > 手卡 > 场上 */
function sacrifice(item: Candidate): number {
  if (item.text.includes('墓地')) return 0
  if (item.text.includes('卡组')) return 1
  if (item.text.includes('手卡')) return 2
  return 3
}

function emptyStats(): AgentStats {
  return {
    calls: 0,
    retries: 0,
    fallbacks: 0,
    failures: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  }
}
