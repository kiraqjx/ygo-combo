/**
 * 启动率求解的 Worker 外壳。
 *
 * 精确解可能在几十万次枚举里打转（预算内也要 1~2 秒），
 * 放在主线程会让整页卡住。这里把整段计算搬到 Worker，
 * 页面照常响应，结果用 id 对账，晚到的旧结果直接丢弃。
 */
import { solveRate, type RateOutcome, type RatePlan } from './rates'
import type { DeckEntry } from '@/types'

export interface RateWorkerRequest {
  id: number
  deck: DeckEntry[]
  plan: RatePlan
}

export interface RateWorkerResponse {
  id: number
  outcome: RateOutcome | null
  error: string
}

/** 只声明用到的 Worker 全局，避免引入 webworker lib 与 DOM lib 冲突 */
interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<RateWorkerRequest>) => void): void
  postMessage(message: RateWorkerResponse): void
}

const ctx = self as unknown as WorkerScope

ctx.addEventListener('message', (event) => {
  const { id, deck, plan } = event.data
  if (!id) return
  let response: RateWorkerResponse
  try {
    response = { id, outcome: solveRate(deck, plan), error: '' }
  } catch (error) {
    response = { id, outcome: null, error: error instanceof Error ? error.message : String(error) }
  }
  ctx.postMessage(response)
})
