import { uid } from '@/lib/infer'
import type { ReplayAnalysis } from '@/lib/duel/replay'

/**
 * 绑在卡组上的 .yrp 录像。
 *
 * 二进制放 IndexedDB（localStorage 只能存字符串，几十 KB 的录像转 base64 又臭又长）；
 * 卡组删除后录像不会自动清，所以记录里带一份 deckName 方便在「对战分析」页做孤儿展示。
 */

const DB_NAME = 'ygo-skill'
const DB_VERSION = 1
const STORE = 'replays'
const INDEX_DECK = 'deckId'

export interface ReplayBindingMeta {
  id: string
  deckId: string
  deckName: string
  /** 展示名，默认「卡组名 · 时间」 */
  name: string
  createdAt: number
  /** 文件字节数 */
  size: number
  /** 解析结果缓存（失败时也存，避免每次生成都重新跑一遍内核） */
  analysis?: ReplayAnalysis
  /** 解析 / 回放的失败原因 */
  error?: string
}

export interface ReplayBinding extends ReplayBindingMeta {
  bytes: Uint8Array
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex(INDEX_DECK, 'deckId', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return dbPromise
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function stripBytes(record: ReplayBinding): ReplayBindingMeta {
  const { bytes: _bytes, ...meta } = record
  return meta
}

export async function listReplayBindings(deckId?: string): Promise<ReplayBindingMeta[]> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const records = deckId
      ? await requestToPromise<ReplayBinding[]>(store.index(INDEX_DECK).getAll(deckId))
      : await requestToPromise<ReplayBinding[]>(store.getAll())
    return records.map(stripBytes).sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

export async function loadReplayBinding(id: string): Promise<ReplayBinding | null> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE, 'readonly')
    const record = await requestToPromise<ReplayBinding | undefined>(tx.objectStore(STORE).get(id))
    return record ?? null
  } catch {
    return null
  }
}

export interface BindReplayInput {
  deckId: string
  deckName: string
  name?: string
  bytes: Uint8Array
}

export async function bindReplay(input: BindReplayInput): Promise<ReplayBindingMeta> {
  const now = Date.now()
  const record: ReplayBinding = {
    id: uid(),
    deckId: input.deckId,
    deckName: input.deckName,
    name: input.name?.trim() || `${input.deckName} · ${formatStamp(now)}`,
    createdAt: now,
    size: input.bytes.byteLength,
    // 复制一份，避免外部 buffer 被回收 / 复用
    bytes: input.bytes.slice(),
  }
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  return stripBytes(record)
}

/** 写入解析结果；analysis 与 error 互斥 */
export async function saveReplayAnalysis(
  id: string,
  result: { analysis?: ReplayAnalysis; error?: string; name?: string },
): Promise<ReplayBindingMeta | null> {
  const record = await loadReplayBinding(id)
  if (!record) return null
  const next: ReplayBinding = { ...record }
  if (result.name) next.name = result.name
  if (result.analysis) {
    next.analysis = result.analysis
    next.error = result.analysis.ok ? undefined : result.analysis.error
  } else if (result.error) {
    next.error = result.error
    next.analysis = undefined
  }
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(next)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  return stripBytes(next)
}

/** 改录像的展示名（空名字视为不改） */
export async function renameReplayBinding(id: string, name: string): Promise<ReplayBindingMeta | null> {
  const clean = name.trim()
  if (!clean) return null
  const record = await loadReplayBinding(id)
  if (!record || record.name === clean) return record ? stripBytes(record) : null
  record.name = clean
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  return stripBytes(record)
}

/** 清掉所属卡组已经不存在的录像（删卡组不会连带动 IndexedDB） */
export async function removeOrphanReplays(deckIds: string[]): Promise<number> {
  const known = new Set(deckIds)
  const orphans = (await listReplayBindings()).filter((item) => !known.has(item.deckId))
  for (const item of orphans) await removeReplayBinding(item.id)
  return orphans.length
}

export async function removeReplayBinding(id: string): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    /* 隐私模式下可能失败，忽略 */
  }
}

/** 卡组被删除 / 重命名时同步录像上的卡组名，避免列表里全是旧名字 */
export async function renameDeckBindings(deckId: string, deckName: string): Promise<void> {
  const metas = await listReplayBindings(deckId)
  for (const meta of metas) {
    const record = await loadReplayBinding(meta.id)
    if (!record || record.deckName === deckName) continue
    record.deckName = deckName
    const db = await openDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(record)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  }
}

function formatStamp(time: number): string {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
