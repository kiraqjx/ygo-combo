import type { CardData, FrameType } from '@/types'

const ZIP_URL = 'https://ygocdb.com/api/v0/cards.zip'
const DB_NAME = 'ygo-infer'
const STORE = 'kv'
const CACHE_KEY = 'cards-v1'
const META_KEY = 'cards-meta-v1'

export interface RawCard {
  id: number
  cid?: number
  cn_name?: string
  sc_name?: string
  md_name?: string
  nwbbs_n?: string
  cnocg_n?: string
  jp_name?: string
  en_name?: string
  text?: { types?: string; desc?: string; pdesc?: string }
  data?: { ot?: number; type?: number; atk?: number; def?: number; level?: number; race?: number; attribute?: number }
}

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet<T>(key: string): Promise<T | null> {
  try {
    const db = await idbOpen()
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => resolve((req.result as T) ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null
  }
}

async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await idbOpen()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    /* 隐私模式下可能失败，忽略 */
  }
}

export async function idbDel(key: string): Promise<void> {
  try {
    const db = await idbOpen()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    /* ignore */
  }
}

export const cardImageUrl = (id: number) => `https://cdn.233.momobako.com/ygopro/pics/${id}.jpg`
export const cardImageFallback = (id: number) => `https://images.ygoprodeck.com/images/cards/${id}.jpg`

/**
 * 卡图的同源地址：dev / preview 由 vite 代理到 momobako，
 * 生产环境用 VITE_CARD_IMG_BASE 指向自己的反代。
 * 只有同源才允许把卡图画进 canvas（导出 GIF）。
 */
export const CARD_IMG_BASE = import.meta.env.VITE_CARD_IMG_BASE || '/pics/'
export const cardImageProxyUrl = (id: number) => `${CARD_IMG_BASE}${id}.jpg`

const NUMBER_WORDS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

export function parseNumberToken(token: string): number | null {
  if (!token) return null
  if (/^\d+$/.test(token)) return Number(token)
  if (token === '十') return 10
  if (/^十[一二三四五六七八九]$/.test(token)) return 10 + (NUMBER_WORDS[token[1]] ?? 0)
  if (/^[一二三四五六七八九]十$/.test(token)) return (NUMBER_WORDS[token[0]] ?? 0) * 10
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(token)) {
    return (NUMBER_WORDS[token[0]] ?? 0) * 10 + (NUMBER_WORDS[token[2]] ?? 0)
  }
  return NUMBER_WORDS[token] ?? null
}

/** 解析 "[怪兽|效果|调整] 不死/炎\n[★3] 0/1800" 这类类型串 */
export function normalizeCard(raw: RawCard): CardData {
  const cnName = raw.cn_name || raw.sc_name || raw.md_name || raw.nwbbs_n || raw.en_name || `未知卡片 ${raw.id}`
  const typeLine = raw.text?.types || ''
  const desc = (raw.text?.desc || '').replace(/\r/g, '')
  const pendDesc = (raw.text?.pdesc || '').replace(/\r/g, '')

  const bracket = typeLine.match(/^\[([^\]]*)\]([\s\S]*)$/)
  const kinds = (bracket?.[1] || '').split('|').map((s) => s.trim()).filter(Boolean)
  const rest = bracket?.[2] || ''

  const statLine = rest.split('\n')[1] || ''
  const levelMatch = statLine.match(/\[(★|LINK|RANK)-?(\d+)\]/i)
  const atkDefMatch = statLine.match(/\]\s*([\d?]+|-)\s*\/\s*([\d?]+|-)/)
  const markerMatch = statLine.match(/\[([↑↗→↘↓↙←↖]+)\]/)
  const scaleMatch = statLine.match(/(\d+)\s*\/\s*(\d+)\s*$/)

  const toNum = (v?: string) => {
    if (!v || v === '-' || v === '?') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  let frame: FrameType = 'monster'
  if (kinds.includes('魔法')) frame = 'spell'
  else if (kinds.includes('陷阱')) frame = 'trap'

  const raceAttr = frame === 'monster' ? (rest.split('\n')[0] || '').trim() : ''
  const [race, attribute] = raceAttr.split('/').map((s) => s.trim())

  let rankLabel: CardData['rankLabel'] = ''
  if (levelMatch) {
    const token = levelMatch[1].toUpperCase()
    rankLabel = token === 'LINK' ? 'LINK' : kinds.includes('超量') ? 'RANK' : '★'
  }

  const names = [cnName, raw.sc_name, raw.md_name, raw.nwbbs_n, raw.cnocg_n, raw.jp_name, raw.en_name]
    .filter(Boolean)
    .join(' ')
  const blob = `${names} ${desc} ${pendDesc}`.toLowerCase().replace(/\s+/g, ' ')

  return {
    id: raw.id,
    name: cnName,
    scName: raw.sc_name,
    jpName: raw.jp_name,
    enName: raw.en_name,
    typeLine: typeLine.replace(/\n/g, ' · '),
    desc,
    pendDesc,
    kinds,
    race: race || undefined,
    attribute: attribute || undefined,
    rankLabel,
    level: levelMatch ? Number(levelMatch[2]) : undefined,
    atk: toNum(atkDefMatch?.[1]),
    def: toNum(atkDefMatch?.[2]),
    scale: scaleMatch ? Number(scaleMatch[1]) : null,
    linkMarkers: markerMatch ? [...markerMatch[1]] : undefined,
    frame,
    blob,
    ot: raw.data?.ot,
  }
}

export interface LoadProgress {
  phase: 'idle' | 'download' | 'extract' | 'parse' | 'ready' | 'error'
  loaded: number
  total: number
  message: string
}

async function downloadZip(onProgress: (loaded: number, total: number) => void): Promise<Uint8Array> {
  const res = await fetch(ZIP_URL)
  if (!res.ok) throw new Error(`卡库下载失败（HTTP ${res.status}）`)
  const total = Number(res.headers.get('content-length') || 0)
  if (!res.body) {
    const buf = await res.arrayBuffer()
    onProgress(buf.byteLength, buf.byteLength)
    return new Uint8Array(buf)
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      loaded += value.byteLength
      onProgress(loaded, total)
    }
  }
  const out = new Uint8Array(loaded)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

export async function loadCardDatabase(onProgress?: (p: LoadProgress) => void): Promise<CardData[]> {
  const report = (p: LoadProgress) => onProgress?.(p)
  const cached = await idbGet<string>(CACHE_KEY)
  if (cached) {
    try {
      report({ phase: 'parse', loaded: 0, total: 0, message: '读取本地卡库…' })
      const cards = JSON.parse(cached) as CardData[]
      if (Array.isArray(cards) && cards.length > 1000) {
        report({ phase: 'ready', loaded: cards.length, total: cards.length, message: `本地卡库 ${cards.length} 张` })
        return cards
      }
    } catch {
      await idbDel(CACHE_KEY)
    }
  }

  report({ phase: 'download', loaded: 0, total: 0, message: '正在下载卡库（约 2.4MB）…' })
  const { unzipSync } = await import('fflate')
  const zip = await downloadZip((loaded, total) =>
    report({ phase: 'download', loaded, total, message: '正在下载卡库…' }),
  )
  report({ phase: 'extract', loaded: 0, total: zip.byteLength, message: '正在解压卡库…' })
  const files = unzipSync(zip)
  const jsonName = Object.keys(files).find((k) => k.endsWith('cards.json'))
  if (!jsonName) throw new Error('卡库压缩包结构异常')
  report({ phase: 'parse', loaded: 0, total: 0, message: '正在解析卡库…' })
  const text = new TextDecoder().decode(files[jsonName])
  const raw = JSON.parse(text) as Record<string, RawCard>
  const cards = Object.values(raw)
    .filter((c) => c && c.id)
    .map(normalizeCard)
  await idbSet(CACHE_KEY, JSON.stringify(cards))
  await idbSet(META_KEY, { updatedAt: Date.now(), count: cards.length })
  report({ phase: 'ready', loaded: cards.length, total: cards.length, message: `卡库就绪 · ${cards.length} 张` })
  return cards
}

export async function getCardCacheMeta(): Promise<{ updatedAt: number; count: number } | null> {
  return idbGet(META_KEY)
}

export async function clearCardCache(): Promise<void> {
  await idbDel(CACHE_KEY)
  await idbDel(META_KEY)
}

/** 卡库不可用时的在线兜底检索 */
export async function remoteSearch(keyword: string): Promise<CardData[]> {
  if (!keyword.trim()) return []
  const res = await fetch(`https://ygocdb.com/api/v0/?search=${encodeURIComponent(keyword.trim())}`)
  if (!res.ok) throw new Error('在线检索失败')
  const json = (await res.json()) as { result?: RawCard[] }
  return (json.result || []).map(normalizeCard)
}
