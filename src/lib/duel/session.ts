import createCore, {
  OcgCoreInternal,
  OcgDuelMode,
  OcgLocation,
  OcgMessageType,
  OcgPosition,
  OcgProcessResult,
  OcgHintType,
  OcgQueryFlags,
  OcgResponseType,
  type OcgCardData,
  type OcgCore,
  type OcgDuelHandle,
  type OcgMessage,
  type OcgResponse,
} from 'ocgcore-wasm'
import jspiWasmUrl from 'ocgcore-wasm/lib/ocgcore.jspi.wasm?url'
import { loadDuelCardSource, type DuelCardSource } from './cards'
import { ScriptStore, DUEL_ASSET_BASE } from './scripts'
import { loadDuelDescriptions, loadDuelStrings, type DuelDescriptions, type DuelStrings } from './strings'
import { encodeResponse, responseMatchesQuestion } from './response'
import { autoRespond } from './auto'
import { createRng, shuffleWith } from './random'
import type {
  DuelCapture,
  DuelCardView,
  DuelDeck,
  DuelEvent,
  DuelLogEntry,
  DuelPlayerId,
  DuelQuestion,
  DuelSignal,
  DuelStartOptions,
  DuelStateView,
} from './types'

/**
 * 异步（JSPI）版和同步版的差别只在"方法返回不返回 Promise"，
 * 业务层一律 await，所以这里统一按异步版注解，同步版强转过来。
 */
type AnyCore = OcgCore

/** 对手固定是 1 号位（沙包） */
export const OPPONENT: DuelPlayerId = 1

const PHASE_LABELS: Record<number, string> = {
  1: '抽卡阶段',
  2: '准备阶段',
  4: '主要阶段 1',
  8: '战斗阶段',
  16: '主要阶段 2',
  32: '结束阶段',
}

export interface DuelSessionEvents {
  /** 状态或待答问题变化 */
  onChange?: () => void
  /** 需要玩家做决定 */
  onQuestion?: (question: DuelQuestion) => void
  /** 内核日志（脚本报错等） */
  onLog?: (text: string) => void
}

export interface DuelSnapshot {
  state: DuelStateView
  question: DuelQuestion | null
  logs: DuelLogEntry[]
  busy: boolean
  error: string | null
  /** 卡组里没有 Lua 脚本的卡号 */
  missingScripts: number[]
  /** 正在回放暂存（自动操作到存档点），界面只显示进度 */
  replaying: boolean
  /** 当前提问的内核提示文案 */
  hint: string
  attack: DuelEvent | null
  damage: DuelEvent | null
  /** 最近一次亮牌（确认卡组顶 / 确认卡片），界面弹提示用 */
  reveal: { id: number; names: string[] } | null
}

let corePromise: Promise<AnyCore> | null = null
let coreIsSync = false

/** 载入内核：优先 JSPI 异步版，不支持时退回同步版 */
async function loadCore(): Promise<AnyCore> {
  if (corePromise) return corePromise
  corePromise = (async (): Promise<AnyCore> => {
    try {
      const binary = await fetch(jspiWasmUrl).then((res) => res.arrayBuffer())
      const core = await createCore({ wasmBinary: binary })
      coreIsSync = false
      return core
    } catch {
      // 浏览器不支持 JSPI 才加载同步版，按需 import 避免首次就把两份 wasm 都拉下来
      const { default: syncUrl } = await import('ocgcore-wasm/lib/ocgcore.sync.wasm?url')
      const binary = await fetch(syncUrl).then((res) => res.arrayBuffer())
      const core = await createCore({ sync: true, wasmBinary: binary })
      coreIsSync = true
      return core as unknown as AnyCore
    }
  })()
  return corePromise
}

export class DuelSession {
  private core: AnyCore | null = null
  private handle: OcgDuelHandle | null = null
  private cards: DuelCardSource | null = null
  private scripts = new ScriptStore()
  private stopped = false

  private pendingQuestion: DuelQuestion | null = null
  private answerResolve: ((response: OcgResponse) => void) | null = null
  private busy = false
  private errorMessage: string | null = null
  /** 最近一次展示给玩家的提问，供 RETRY 时重复提问 */
  private lastQuestion: DuelQuestion | null = null
  private sawRetry = false
  private retryCount = 0

  /** 供 .yrp 导出：按顺序记录的响应字节（含沙包） */
  readonly responses: Uint8Array[] = []
  /** 只记我方的响应对象，暂存恢复时按顺序回放（沙包走确定性策略，不必存） */
  readonly playerResponses: OcgResponse[] = []
  /** 录像回放时记下的「提问 → 原始响应」，用来把录像翻译成操作说明 */
  readonly captures: DuelCapture[] = []
  /** 结构化事件流：手坑命中分析用（见 replayHandtraps） */
  readonly signals: DuelSignal[] = []
  /** 暂存恢复用的待回放队列 */
  private replayQueue: OcgResponse[] = []
  /** 录像回放：按顺序直接喂给内核的响应字节 */
  private rawQueue: Uint8Array[] | null = null
  /** 回放中：界面不必参与，回放完再交还控制权 */
  private replaying = false
  /** 主循环是否已经退出（录像分析要等它跑完） */
  private loopDone = false
  private loopWaiters: (() => void)[] = []

  private readonly logList: DuelLogEntry[] = []
  private logSeq = 0
  /** 日志保留条数 */
  private readonly logLimit: number
  /** 没有 Lua 脚本的卡（效果不会生效） */
  private missingScripts: number[] = []
  /** 实际喂给内核的（已洗好的）卡组，导出录像要用同一份 */
  private decks: { player: DuelDeck; opponent: DuelDeck } | null = null

  private state: DuelStateView = emptyState()
  /** 已经开始的回合数（NEW_TURN 的计数），state.turn 由它派生 */
  private turnCount = 0

  /** strings.conf 的提示文案 */
  private strings: DuelStrings = { system: {} }
  /** 每张卡的效果分条（选项名用） */
  private descriptions: DuelDescriptions = {}
  /** 当前提问的提示（"请选择要丢弃的手卡"之类） */
  private hintText = ''
  /** 最近一次攻击/伤害，界面据此播动画 */
  private lastAttack: DuelEvent | null = null
  private lastDamage: DuelEvent | null = null
  private eventSeq = 0
  /** 最近一次亮牌（确认卡组顶 / 确认卡片），界面弹一条提示告诉玩家翻了什么 */
  private lastReveal: { id: number; names: string[] } | null = null

  constructor(
    private readonly options: DuelStartOptions,
    private readonly resolveName: (code: number) => string,
    private readonly events: DuelSessionEvents = {},
  ) {
    this.replayQueue = [...(options.replay ?? [])]
    this.rawQueue = options.rawResponses ? [...options.rawResponses] : null
    this.logLimit = options.logLimit ?? 300
  }

  private get syncMode() {
    return coreIsSync
  }

  /* ---------------------------------------------------------------- */
  /* 生命周期                                                          */
  /* ---------------------------------------------------------------- */

  async start(): Promise<void> {
    this.busy = true
    this.emit()
    try {
      const [core, cards, strings, descriptions] = await Promise.all([
        loadCore(),
        loadDuelCardSource(DUEL_ASSET_BASE),
        loadDuelStrings(DUEL_ASSET_BASE),
        loadDuelDescriptions(DUEL_ASSET_BASE),
      ])
      this.core = core
      this.strings = strings
      this.descriptions = descriptions
      this.cards = cards

      const codes = uniqueCodes([...this.options.playerDeck.main, ...this.options.playerDeck.extra, ...this.options.opponentDeck.main, ...this.options.opponentDeck.extra])
      const missing = cards.missing(codes)
      if (missing.length) {
        throw new Error(
          `内核卡库里没有这些卡：${missing.map((code) => `「${this.nameOf(code)}」#${code}`).join('、')}。` +
            '如果卡组刚更新过，先运行 npm run assets:duel 重建卡数据。',
        )
      }

      this.scripts = new ScriptStore()
      await this.scripts.preload(codes)
      // 缺脚本的卡会被内核当成"没有效果的卡"，不致命但会影响演练，界面要提示
      this.missingScripts = [...this.scripts.missingCodes].sort((a, b) => a - b)

      const handle = await core.createDuel({
        flags: OcgDuelMode.MODE_MR5,
        seed: this.options.seed,
        team1: teamOptions(this.options),
        team2: teamOptions(this.options),
        cardReader: (code) => cards.get(code),
        scriptReader: (name) => this.scripts.getSync(name),
        errorHandler: (_type, text) => this.pushKernelError(text),
      })
      if (!handle) throw new Error('对局创建失败（内核没有返回句柄）')
      this.handle = handle

      // 公共脚本必须在添卡之前进内核，否则卡片脚本里的 aux / 常量全是 nil
      for (const name of await this.scripts.helpers()) {
        const content = this.scripts.getSync(name)
        if (content) await core.loadScript(handle, name, content)
      }

      const prebuilt = this.options.prebuiltDecks
      if (prebuilt) {
        // 录像回放：卡组已经是录像里记录的实际顺序，再洗一次就对不上了
        this.decks = {
          player: { main: [...prebuilt.player.main], extra: [...prebuilt.player.extra] },
          opponent: { main: [...prebuilt.opponent.main], extra: [...prebuilt.opponent.extra] },
        }
      } else {
        // 内核不会自己洗牌，这里按种子洗好再按"倒序插入"（最后加入的在卡组顶）
        const rng = createRng(this.options.seed)
        const playerMain = shuffleWith(this.options.playerDeck.main, rng)
        const playerExtra = shuffleWith(this.options.playerDeck.extra, rng)
        const opponentMain = shuffleWith(this.options.opponentDeck.main, rng)
        const opponentExtra = shuffleWith(this.options.opponentDeck.extra, rng)
        this.decks = {
          player: {
            main: hoistOpeningHand(playerMain, this.options.openingHand),
            extra: playerExtra,
          },
          opponent: { main: opponentMain, extra: opponentExtra },
        }
      }

      await this.addDeck(0, this.decks.player)
      await this.addDeck(1, this.decks.opponent)

      this.state = emptyState()
      this.state.players[0].lp = this.options.startingLP ?? 8000
      this.state.players[1].lp = this.options.startingLP ?? 8000
      this.state.turnPlayer = 0
      this.state.turn = 1

      await core.startDuel(handle)
      this.pushLog(-1, '决斗开始')
      this.busy = false
      void this.loop()
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error)
      this.busy = false
      this.emit()
      throw error
    }
  }

  private async addDeck(team: 0 | 1, deck: DuelDeck) {
    const core = this.core!
    const handle = this.handle!
    const add = async (code: number, location: OcgLocation) => {
      await core.duelNewCard(handle, {
        team,
        duelist: 0,
        code,
        controller: team,
        location,
        sequence: 0,
        position: OcgPosition.FACEDOWN_DEFENSE,
      })
    }
    // 后加入的卡在卡组顶，所以倒序插入，洗好的第一张才会最先抽到
    for (let index = deck.main.length - 1; index >= 0; index -= 1) await add(deck.main[index], OcgLocation.DECK)
    for (let index = deck.extra.length - 1; index >= 0; index -= 1) await add(deck.extra[index], OcgLocation.EXTRA)
  }

  stop() {
    this.stopped = true
    // 让还挂在界面上的提问立刻返回，主循环随后自行退出
    const resolve = this.answerResolve
    this.answerResolve = null
    resolve?.({ type: OcgResponseType.SELECT_YESNO, yes: false })
    if (this.core && this.handle) {
      try {
        this.core.destroyDuel(this.handle)
      } catch {
        /* 已经结束的对局销毁会抛错，忽略 */
      }
    }
    this.handle = null
    this.markLoopDone()
  }

  /* ---------------------------------------------------------------- */
  /* 主循环                                                            */
  /* ---------------------------------------------------------------- */

  private async loop() {
    const core = this.core!
    const handle = this.handle!
    try {
      while (!this.stopped && this.handle) {
        const status = await core.duelProcess(handle)
        const messages = core.duelGetMessage(handle)
        this.consume(messages)
        this.rebuild()

        if (this.stopped) return

        if (status === OcgProcessResult.END) {
          this.state.finished = true
          this.pendingQuestion = null
          this.busy = false
          this.emit()
          return
        }
        if (status === OcgProcessResult.CONTINUE) continue

        const question = this.takeQuestion()
        // 记一笔「现在轮到谁拿到连锁响应权」：
        // 自排连锁时中间那几条连锁前后没有对手的响应窗口，手坑够不到
        if (question?.kind === 'chain') {
          this.signals.push({
            turn: this.state.turn,
            phase: this.state.phase,
            player: question.player,
            kind: 'prompt',
            code: 0,
            name: '',
            chainSize: 0,
          })
        }

        // 录像回放：不经过界面 / 沙包策略，直接把录下来的字节按顺序喂回去
        if (this.rawQueue) {
          const bytes = this.rawQueue.shift()
          if (!bytes) {
            this.rawQueue = null
            this.busy = false
            this.emit()
            return
          }
          if (question) {
            this.captures.push({
              player: question.player,
              kind: question.kind,
              response: bytes,
              labels: this.questionLabels(question),
              turn: this.state.turn,
              phase: this.state.phase,
            })
          }
          this.writeRawResponse(bytes)
          continue
        }

        let response: OcgResponse

        if (!question) {
          // 内核返回 RETRY 说明上一次答复被判非法（例如选了不能取消的取消），
          // 把同一个问题再问一遍；没有 RETRY 又没有问题就没法继续了。
          if (!this.sawRetry || !this.lastQuestion) {
            throw new Error('内核在等待一个无法识别的操作，对局已停止')
          }
          this.retryCount += 1
          if (this.retryCount > 8) throw new Error('内核连续拒绝选择，对局已停止')
          response = await this.resolveAnswer(this.lastQuestion, true)
        } else {
          this.retryCount = 0
          this.lastQuestion = question
          response = await this.resolveAnswer(question, false)
        }

        if (this.stopped) return
        this.responses.push(encodeResponse(response))
        // 暂存只需要我方的决定：沙包的回答是确定性的，回放时会重新算出来
        // （RETRY 时 question 为 null，lastQuestion 就是那个还被重答的我方问题）
        const owner = question?.player ?? this.lastQuestion?.player ?? 0
        if (owner !== OPPONENT) this.playerResponses.push(response)
        this.setResponse(response)
      }
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error)
      this.busy = false
      this.emit()
    } finally {
      this.markLoopDone()
    }
  }

  /**
   * 提交响应。
   *
   * SORT_CARD 必须绕开 ocgcore-wasm 的 duelSetResponse：库把这个响应的首字节写成
   * 「卡片数」，而内核要的是「卡片数 - 1」，于是任何排序都会被判非法并 RETRY。
   * 界面上就表现为「排好第一张，点第二张后面板重置」。
   */
  private setResponse(response: OcgResponse) {
    const core = this.core
    const handle = this.handle
    if (!core || !handle) return
    const order = response.type === OcgResponseType.SORT_CARD ? response.order : null
    if (!order?.length) {
      core.duelSetResponse(handle, response)
      return
    }
    const bytes = new Uint8Array(order.length + 1)
    bytes[0] = order.length - 1
    order.forEach((index, position) => {
      bytes[position + 1] = index
    })
    this.writeRawResponse(bytes)
  }

  /**
   * 直接把原始响应字节塞给内核（对应 ocgcore 的 set_responseb）。
   * 录像回放走这条路：.yrp 里存的就是这些字节，再解一遍反而容易失真。
   */
  private writeRawResponse(bytes: Uint8Array) {
    const core = this.core
    const handle = this.handle
    if (!core || !handle) return
    // OcgDuelHandle 是包装对象，真正的 wasm 指针挂在内部 symbol 上
    const inner = Object.getOwnPropertySymbols(handle)
      .map((key) => (handle as unknown as Record<symbol, { handle?: number }>)[key])
      .find((item) => typeof item?.handle === 'number')
    if (!inner) return
    // 类型声明里没有 HEAPU8（emscripten 运行时一定有），按实际用到的接口描述即可
    const module = core[OcgCoreInternal].module as unknown as {
      HEAPU8: Uint8Array
      stackSave(): number
      stackAlloc(size: number): number
      stackRestore(pointer: number): void
      _ocgapiDuelSetResponse(duel: number, pointer: number, length: number): void
    }
    const saved = module.stackSave()
    const pointer = module.stackAlloc(Math.max(bytes.byteLength, 1))
    try {
      module.HEAPU8.set(bytes, pointer)
      module._ocgapiDuelSetResponse(inner.handle!, pointer, bytes.byteLength)
    } finally {
      module.stackRestore(saved)
    }
  }

  /** 等主循环退出（录像回放 / 自动回放用） */
  waitForEnd(): Promise<void> {
    if (this.loopDone) return Promise.resolve()
    return new Promise((resolve) => {
      this.loopWaiters.push(resolve)
    })
  }

  private markLoopDone() {
    this.loopDone = true
    const waiters = this.loopWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  /** 对手交给沙包策略；我方则挂起等待界面回答 */
  private async resolveAnswer(question: DuelQuestion, lenient: boolean): Promise<OcgResponse> {
    if (question.player === OPPONENT) return autoRespond(question, { lenient })
    // 暂存恢复：按记录顺序回放我方的决定，界面不参与。
    //
    // RETRY（上一次答复被判非法）同样要从队列里取：暂存时那一次「被拒 + 重答」
    // 是两条独立响应，两条都记进了队列。如果 RETRY 时跳过队列、交给人工，
    // 队列后面的项就会整体错位，回放停在出错的那一步（表现为"还停在之前的步骤"）。
    if (this.replayQueue.length) {
      const replayed = this.takeReplayResponse(question)
      if (replayed) {
        this.replaying = true
        return replayed
      }
    }
    this.replaying = false
    // 内核每组建一次连锁都会把两个玩家各问一遍，哪怕你没有能连锁的卡——
    // 这时 selects 是空的，客户端应当直接替玩家放弃（EDOPro 也是这么做），
    // 否则界面上只剩一个"不发动"，看着像卡住了。
    if (question.kind === 'chain' && !question.message.forced && question.message.selects.length === 0) {
      return { type: OcgResponseType.SELECT_CHAIN, index: null }
    }
    this.busy = false
    this.pendingQuestion = question
    this.emit()
    const response = await this.waitAnswer()
    this.busy = true
    this.pendingQuestion = null
    return response
  }

  /**
   * 从回放队列取一条能回答当前提问的响应。
   *
   * 旧版本存的暂存可能夹着内核拒过的重复响应、或整体错开一格，
   * 类型对不上就跳过（记一条日志），避免一条脏数据把后面所有步骤卡死。
   */
  private takeReplayResponse(question: DuelQuestion): OcgResponse | null {
    while (this.replayQueue.length) {
      const response = this.replayQueue.shift()!
      if (responseMatchesQuestion(response, question)) return response
      this.pushLog(-1, '回放：跳过一条与当前提问不符的操作')
    }
    return null
  }

  private waitAnswer(): Promise<OcgResponse> {
    return new Promise((resolve) => {
      this.answerResolve = resolve
    })
  }

  /**
   * 玩家在界面上做出的决定。
   *
   * 内核没有在等回答时（重复点击、上一帧的面板残留）必须直接忽略：
   * 否则会把 busy 置真、把 pendingQuestion 清空，界面再也等不到新提问，
   * 看起来就是「点了一下之后彻底卡住」。
   */
  answer(response: OcgResponse): boolean {
    const resolve = this.answerResolve
    if (!resolve) return false
    this.answerResolve = null
    this.pendingQuestion = null
    this.busy = true
    this.emit()
    resolve(response)
    return true
  }

  /* ---------------------------------------------------------------- */
  /* 消息处理                                                          */
  /* ---------------------------------------------------------------- */

  private questionFromMessage: DuelQuestion | null = null

  private consume(messages: OcgMessage[]) {
    this.questionFromMessage = null
    this.sawRetry = messages.some((message) => message.type === OcgMessageType.RETRY)
    let batchHint = ''
    for (const message of messages) {
      if (message.type === OcgMessageType.HINT && message.hint_type === OcgHintType.SELECTMSG) {
        batchHint = this.strings.system[Number(message.hint)] ?? ''
      }
      const question = toQuestion(message)
      if (question) this.questionFromMessage = question
      this.pushLogFor(message)
      this.applySimple(message)
    }
    // 提示通常和提问同一批到达；新提问没有提示时清掉旧文案，避免张冠李戴
    if (this.questionFromMessage) this.hintText = batchHint
  }

  private takeQuestion(): DuelQuestion | null {
    const question = this.questionFromMessage
    this.questionFromMessage = null
    return question
  }

  private applySimple(message: OcgMessage) {
    switch (message.type) {
      case OcgMessageType.NEW_TURN:
        // state.turn 的初始值是 1（还没收到第一回合消息时的占位），
        // 所以不能直接 += 1，否则开局第一回合就显示成「第 2 回合」
        this.turnCount += 1
        this.state.turn = this.turnCount
        this.state.turnPlayer = message.player === 1 ? 1 : 0
        break
      case OcgMessageType.NEW_PHASE:
        this.state.phase = message.phase
        break
      case OcgMessageType.LPUPDATE:
        if (message.player === 0 || message.player === 1) this.state.players[message.player].lp = message.lp
        break
      case OcgMessageType.PAY_LPCOST:
        // 支付 LP 代价只发 PAY_LPCOST，内核不会再补一条 LPUPDATE
        if (message.player === 0 || message.player === 1) {
          const player = this.state.players[message.player]
          player.lp = Math.max(0, player.lp - message.amount)
        }
        break
      case OcgMessageType.WIN:
        this.state.finished = true
        this.state.winner = message.player === 1 ? 1 : 0
        break
      case OcgMessageType.ATTACK: {
        const attacker = message.card
        const target = message.target
        this.eventSeq += 1
        this.lastAttack = {
          id: this.eventSeq,
          player: attacker.controller,
          controller: attacker.controller,
          location: attacker.location,
          sequence: attacker.sequence,
          code: this.codeAt(attacker),
          targetLocation: target?.location,
          targetSequence: target?.sequence,
          targetCode: target ? this.codeAt(target) : 0,
        }
        break
      }
      case OcgMessageType.DAMAGE:
      case OcgMessageType.RECOVER:
        // 伤害 / 回复同样只发本条消息（LPUPDATE 只在 SetLP 时出现），要自己同步 LP
        if (message.player === 0 || message.player === 1) {
          const player = this.state.players[message.player]
          const delta = message.type === OcgMessageType.RECOVER ? message.amount : -message.amount
          player.lp = Math.max(0, player.lp + delta)
        }
        this.eventSeq += 1
        this.lastDamage = {
          id: this.eventSeq,
          player: message.player,
          amount: message.amount,
        }
        break
      case OcgMessageType.CHAINING:
        this.state.chain = [
          ...this.state.chain,
          {
            code: message.code,
            name: this.nameOf(message.code),
            link: message.chain_size,
          },
        ]
        break
      case OcgMessageType.CHAIN_END:
        this.state.chain = []
        break
      default:
        break
    }
  }

  /**
   * 记录手坑分析需要的关键事件。
   * 日志文本只有「发动卡片 · X」，判断能吃什么手坑还需要区域、连锁号与卡移动，
   * 所以这些消息单独留一份精简记录，供 replayHandtraps 做规则匹配。
   */
  private recordSignal(message: OcgMessage) {
    if (this.signals.length >= 4000) return
    const base = {
      turn: this.state.turn,
      phase: this.state.phase,
      player: -1,
      chainSize: 0,
    }
    const spot = (loc: {
      controller: number
      location: number
      sequence: number
      position?: number
    }) => ({
      controller: loc.controller,
      location: loc.location,
      sequence: loc.sequence,
      ...(loc.position === undefined ? {} : { position: loc.position }),
    })

    switch (message.type) {
      case OcgMessageType.SUMMONING:
        this.signals.push({ ...base, kind: 'summon', player: message.controller, code: message.code, name: this.nameOf(message.code) })
        break
      case OcgMessageType.SPSUMMONING:
        this.signals.push({ ...base, kind: 'spsummon', player: message.controller, code: message.code, name: this.nameOf(message.code) })
        break
      case OcgMessageType.FLIPSUMMONING:
        this.signals.push({ ...base, kind: 'flip', player: message.controller, code: message.code, name: this.nameOf(message.code) })
        break
      case OcgMessageType.SUMMONED:
        this.signals.push({ ...base, kind: 'summoned', code: 0, name: '' })
        break
      case OcgMessageType.SPSUMMONED:
        this.signals.push({ ...base, kind: 'spsummoned', code: 0, name: '' })
        break
      case OcgMessageType.FLIPSUMMONED:
        this.signals.push({ ...base, kind: 'flipsummoned', code: 0, name: '' })
        break
      case OcgMessageType.SET:
        this.signals.push({
          ...base,
          kind: 'set',
          player: message.controller,
          code: message.code,
          name: this.nameOf(message.code),
          to: spot(message),
        })
        break
      case OcgMessageType.POS_CHANGE:
        this.signals.push({
          ...base,
          kind: 'position',
          player: message.controller,
          code: message.code,
          name: this.nameOf(message.code),
          from: spot({ ...message, position: message.prev_position }),
          to: spot(message),
        })
        break
      case OcgMessageType.CHAINING:
        this.signals.push({
          ...base,
          kind: 'chain',
          player: message.controller,
          code: message.code,
          name: this.nameOf(message.code),
          chainSize: message.chain_size,
          from: { controller: message.controller, location: message.location, sequence: message.sequence },
        })
        break
      case OcgMessageType.CHAIN_SOLVING:
        this.signals.push({ ...base, kind: 'solving', code: 0, name: '', chainSize: message.chain_size })
        break
      case OcgMessageType.CHAIN_SOLVED:
        this.signals.push({ ...base, kind: 'solved', code: 0, name: '', chainSize: message.chain_size })
        break
      case OcgMessageType.CHAIN_NEGATED:
        this.signals.push({ ...base, kind: 'negated', code: 0, name: '', chainSize: message.chain_size })
        break
      case OcgMessageType.MOVE:
        this.signals.push({
          ...base,
          kind: 'move',
          player: message.to.controller,
          code: message.card,
          name: this.nameOf(message.card),
          from: spot(message.from),
          to: spot(message.to),
          reason: message.reason,
        })
        break
      case OcgMessageType.DRAW:
        this.signals.push({
          ...base,
          kind: 'draw',
          player: message.player,
          code: 0,
          name: '',
          count: message.drawn.length,
        })
        break
      default:
        break
    }
  }

  private pushLogFor(message: OcgMessage) {
    this.recordSignal(message)
    const who = (player: number) => (player === 0 ? '我方' : '对手')
    switch (message.type) {
      case OcgMessageType.NEW_TURN:
        // 日志先于状态更新执行：turnCount 还是「已结束的回合数」，+1 才是这一回合
        this.pushLog(-1, `第 ${this.turnCount + 1} 回合 · ${who(message.player)}`)
        break
      case OcgMessageType.NEW_PHASE:
        this.pushLog(-1, `进入${PHASE_LABELS[message.phase] ?? '新阶段'}`)
        break
      case OcgMessageType.DRAW:
        this.pushLog(message.player, `${who(message.player)}抽了 ${message.drawn.length} 张卡`)
        break
      case OcgMessageType.SUMMONING:
        this.pushLog(message.controller, `${who(message.controller)}召唤「${this.nameOf(message.code)}」`)
        break
      case OcgMessageType.SPSUMMONING:
        this.pushLog(message.controller, `${who(message.controller)}特殊召唤「${this.nameOf(message.code)}」`)
        break
      case OcgMessageType.FLIPSUMMONING:
        this.pushLog(message.controller, `${who(message.controller)}翻转召唤「${this.nameOf(message.code)}」`)
        break
      case OcgMessageType.SET:
        this.pushLog(message.controller, `${who(message.controller)}盖放「${this.nameOf(message.code)}」`)
        break
      case OcgMessageType.POS_CHANGE:
        this.pushLog(message.controller, `${who(message.controller)}变更「${this.nameOf(message.code)}」的表示形式`)
        break
      case OcgMessageType.CHAINING:
        this.pushLog(message.controller, `C${message.chain_size} 发动「${this.nameOf(message.code)}」`)
        break
      case OcgMessageType.CHAIN_SOLVED:
        this.pushLog(-1, `C${message.chain_size} 结算`)
        break
      case OcgMessageType.CHAIN_NEGATED:
        this.pushLog(-1, `C${message.chain_size} 被无效`)
        break
      case OcgMessageType.CHAIN_END:
        this.pushLog(-1, '连锁结束')
        break
      case OcgMessageType.LPUPDATE:
        this.pushLog(message.player, `${who(message.player)} LP → ${message.lp}`)
        break
      case OcgMessageType.ATTACK: {
        const attackerName = this.nameOf(this.codeAt(message.card))
        const targetName = message.target ? this.nameOf(this.codeAt(message.target)) : ''
        const suffix = targetName ? `「${targetName}」` : '对方玩家'
        this.pushLog(message.card.controller, `${who(message.card.controller)}用「${attackerName}」攻击${suffix}`)
        break
      }
      case OcgMessageType.DAMAGE:
        this.pushLog(message.player, `${who(message.player)}受到 ${message.amount} 点伤害`)
        break
      case OcgMessageType.RECOVER:
        this.pushLog(message.player, `${who(message.player)}回复 ${message.amount} 点 LP`)
        break
      case OcgMessageType.PAY_LPCOST:
        this.pushLog(message.player, `${who(message.player)}支付 ${message.amount} 点 LP`)
        break
      case OcgMessageType.WIN:
        this.pushLog(-1, message.player === 0 ? '我方获胜' : '对手获胜')
        break
      case OcgMessageType.CONFIRM_DECKTOP:
      case OcgMessageType.CONFIRM_CARDS: {
        const names = message.cards.map((card) => this.nameOf(card.code))
        this.pushLog(message.player, `${who(message.player)}确认：${names.join('、')}`)
        this.eventSeq += 1
        this.lastReveal = { id: this.eventSeq, names }
        break
      }
      default:
        break
    }
  }

  /* ---------------------------------------------------------------- */
  /* 场地状态                                                          */
  /* ---------------------------------------------------------------- */

  private rebuild() {
    const core = this.core
    const handle = this.handle
    if (!core || !handle) return

    const field = core.duelQueryField(handle)
    const chain = (field.chain || []).map((entry) => ({
      code: entry.code,
      name: this.nameOf(entry.code),
      link: 0,
    }))

    for (const player of [0, 1] as const) {
      const info = field.players[player]
      const view = this.state.players[player]
      view.deckCount = info.deck_size
      view.extraCount = info.extra_size
      view.handCount = info.hand_size
      view.monsters = padTo(this.queryZone(player, OcgLocation.MZONE), 7)
      view.spells = [
        ...padTo(this.queryZone(player, OcgLocation.SZONE), 5),
        ...padTo(this.queryZone(player, OcgLocation.PZONE), 2),
      ]
      view.fieldZone = this.queryZone(player, OcgLocation.FZONE)[0] ?? null
      view.gy = this.queryZone(player, OcgLocation.GRAVE).filter(Boolean) as DuelCardView[]
      view.banished = this.queryZone(player, OcgLocation.REMOVED).filter(Boolean) as DuelCardView[]
      // 额外卡组要能随时查看 / 从里面特殊召唤，所以整组查出来（下标即 sequence）
      view.extra = this.queryZone(player, OcgLocation.EXTRA)
      // 对手手卡只显示张数，不查卡号
      view.hand = player === 0 ? (this.queryZone(player, OcgLocation.HAND).filter(Boolean) as DuelCardView[]) : []
    }

    this.state.chain = chain
  }

  /** 查询某个区域的全部卡（下标即格位） */
  private queryZone(player: 0 | 1, location: OcgLocation): (DuelCardView | null)[] {
    const core = this.core!
    const handle = this.handle!
    const list = core.duelQueryLocation(handle, {
      flags: (OcgQueryFlags.CODE |
        OcgQueryFlags.POSITION |
        OcgQueryFlags.OVERLAY_CARD |
        OcgQueryFlags.IS_HIDDEN) as OcgQueryFlags,
      controller: player,
      location,
    })
    return list.map((hit) => {
      if (!hit || !hit.code) return null
      return this.toView(hit.code, hit.position ?? 0, Boolean(hit.isHidden), hit.overlayCards)
    })
  }

  private toView(code: number, position: number, hidden: boolean, overlayCodes?: number[]): DuelCardView {
    return {
      code,
      name: hidden && !this.debugReveal ? '盖放卡片' : this.nameOf(code),
      position,
      hidden,
      materials: overlayCodes?.length ?? 0,
      overlayCodes,
    }
  }

  /** 沙包对局里对手没有暗牌可藏，但保留开关方便以后做正规对局 */
  private debugReveal = false

  /* ---------------------------------------------------------------- */
  /* 其它                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 录像回放时把提问的可选项翻译成文案：后面要靠它把"响应字节"还原成
   * 「发动了哪张卡 / 选了哪个选项」，否则 skill 里只剩一串数字。
   */
  private questionLabels(question: DuelQuestion): string[] {
    switch (question.kind) {
      case 'chain':
        return question.message.selects.map((card) => this.nameOf(card.code))
      case 'option':
        return question.message.options.map((id) => this.describeId(Number(id)))
      case 'yesno':
        return ['是', '否']
      case 'card':
      case 'tribute':
      case 'sum':
        return question.message.selects.map((card) => this.nameOf(card.code))
      case 'unselect':
        return question.message.select_cards.map((card) => this.nameOf(card.code))
      case 'sort':
        return question.message.cards.map((card) => this.nameOf(card.code))
      default:
        return []
    }
  }

  /** 选项 id：< 10000 查 strings.conf，否则按 `卡号 << 20 | 分条` 查效果文本 */
  private describeId(raw: number): string {
    const system = this.strings.system[raw]
    if (system) return system
    const code = Math.floor(raw / 0x100000)
    const index = raw % 0x100000
    return this.descriptions[code]?.[index] ?? ''
  }

  private nameOf(code: number): string {
    return this.resolveName(code) || `#${code}`
  }

  /** 按位置查卡号（攻击等消息只给位置，不给卡号） */
  private codeAt(position: { controller: number; location: number; sequence: number }): number {
    const core = this.core
    const handle = this.handle
    if (!core || !handle) return 0
    const hit = core.duelQuery(handle, {
      flags: OcgQueryFlags.CODE,
      controller: position.controller === 1 ? 1 : 0,
      location: position.location as OcgLocation,
      sequence: position.sequence,
      overlaySequence: 0,
    })
    return hit?.code ?? 0
  }

  /** 内核脚本报错：同样的报错只留一条并累计次数，别把日志刷爆 */
  private pushKernelError(text: string) {
    const existing = this.logList.find((entry) => entry.kernel && entry.kernel === text)
    if (existing) {
      existing.repeat = (existing.repeat ?? 1) + 1
      existing.text = `内核：${text}（×${existing.repeat}）`
      return
    }
    this.logSeq += 1
    this.logList.push({ id: this.logSeq, player: -1, text: `内核：${text}`, kernel: text, repeat: 1 })
    if (this.logList.length > this.logLimit) this.logList.splice(0, this.logList.length - this.logLimit)
  }

  private pushLog(player: number, text: string) {
    this.logSeq += 1
    this.logList.push({ id: this.logSeq, player, text })
    if (this.logList.length > this.logLimit) this.logList.splice(0, this.logList.length - this.logLimit)
  }

  private emit() {
    this.events.onChange?.()
    if (this.pendingQuestion) this.events.onQuestion?.(this.pendingQuestion)
  }

  snapshot(): DuelSnapshot {
    return {
      state: this.state,
      question: this.pendingQuestion,
      logs: this.logList,
      busy: this.busy,
      error: this.errorMessage,
      missingScripts: this.missingScripts,
      replaying: this.replaying,
      hint: this.hintText,
      attack: this.lastAttack,
      damage: this.lastDamage,
      reveal: this.lastReveal,
    }
  }

  /** strings.conf 里 !system 段的中文（选项 id < 10000 时用它翻译） */
  systemText(id: number): string {
    return this.strings.system[id] ?? ''
  }

  /** 卡效果的第 index 条分条（对应脚本里的 aux.Stringid(code, index)） */
  cardDescriptionText(code: number, index: number): string {
    return this.descriptions[code]?.[index] ?? ''
  }

  get sync() {
    return this.syncMode
  }

  /** 洗好的卡组快照（.yrp 里必须写这份顺序，否则回放对不上） */
  get builtDecks() {
    return this.decks
  }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function emptyPlayer() {
  return {
    lp: 8000,
    hand: [],
    handCount: 0,
    deckCount: 0,
    extraCount: 0,
    gy: [],
    banished: [],
    monsters: Array.from({ length: 7 }, () => null),
    spells: Array.from({ length: 7 }, () => null),
    fieldZone: null,
    extra: [],
  } as DuelStateView['players'][0]
}

function emptyState(): DuelStateView {
  return {
    turn: 1,
    phase: 0,
    turnPlayer: 0,
    players: [emptyPlayer(), emptyPlayer()],
    chain: [],
    finished: false,
    winner: null,
  }
}

function teamOptions(options: DuelStartOptions) {
  return {
    startingLP: options.startingLP ?? 8000,
    startingDrawCount: options.startingHand ?? 5,
    drawCountPerTurn: options.drawCount ?? 1,
  }
}

function uniqueCodes(codes: number[]): number[] {
  return [...new Set(codes)]
}

/**
 * 自选起手：把指定的卡从洗好的牌堆里提出来，按选择顺序放到最前面。
 * addDeck 是倒序插入（数组头部最先抽到），所以前 startingHand 张就是起手。
 * 找不到的卡号直接跳过（卡组改过之后选了已删掉的卡）。
 */
function hoistOpeningHand(main: number[], hand?: number[]): number[] {
  if (!hand || !hand.length) return main
  const rest = [...main]
  const top: number[] = []
  for (const code of hand) {
    const index = rest.indexOf(code)
    if (index < 0) continue
    top.push(code)
    rest.splice(index, 1)
  }
  return [...top, ...rest]
}

/** 补齐到固定格位数，方便界面按下标渲染 */
function padTo<T>(list: (T | null)[], length: number): (T | null)[] {
  const out: (T | null)[] = list.slice(0, length)
  while (out.length < length) out.push(null)
  return out
}

function toQuestion(message: OcgMessage): DuelQuestion | null {
  const player = (message as { player?: number }).player
  if (typeof player !== 'number') return null
  const id: DuelPlayerId = player === 1 ? 1 : 0
  switch (message.type) {
    case OcgMessageType.SELECT_IDLECMD:
      return { kind: 'idle', player: id, message }
    case OcgMessageType.SELECT_BATTLECMD:
      return { kind: 'battle', player: id, message }
    case OcgMessageType.SELECT_CHAIN:
      return { kind: 'chain', player: id, message }
    case OcgMessageType.SELECT_YESNO:
    case OcgMessageType.SELECT_EFFECTYN:
      return { kind: 'yesno', player: id, message }
    case OcgMessageType.SELECT_OPTION:
      return { kind: 'option', player: id, message }
    case OcgMessageType.SELECT_CARD:
      return { kind: 'card', player: id, message }
    case OcgMessageType.SELECT_TRIBUTE:
      return { kind: 'tribute', player: id, message }
    case OcgMessageType.SELECT_SUM:
      return { kind: 'sum', player: id, message }
    case OcgMessageType.SELECT_UNSELECT_CARD:
      return { kind: 'unselect', player: id, message }
    case OcgMessageType.SELECT_PLACE:
    case OcgMessageType.SELECT_DISFIELD:
      return { kind: 'place', player: id, message }
    case OcgMessageType.SELECT_POSITION:
      return { kind: 'position', player: id, message }
    case OcgMessageType.SORT_CARD:
    case OcgMessageType.SORT_CHAIN:
      return { kind: 'sort', player: id, message: message as never }
    case OcgMessageType.ANNOUNCE_RACE:
    case OcgMessageType.ANNOUNCE_ATTRIB:
    case OcgMessageType.ANNOUNCE_CARD:
    case OcgMessageType.ANNOUNCE_NUMBER:
    case OcgMessageType.ROCK_PAPER_SCISSORS:
    case OcgMessageType.SELECT_COUNTER:
      return { kind: 'other', player: id, message }
    default:
      return null
  }
}

export type { OcgCardData }
