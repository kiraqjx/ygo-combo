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

/** 决斗资源前缀（与 src/lib/duel/scripts.ts 的 DUEL_ASSET_BASE 同一份约定） */
const DUEL_ASSET_BASE = `${(import.meta.env.VITE_DUEL_ASSET_BASE || '/duel-assets/').replace(/\/+$/, '')}/`

/**
 * 超先行服的临时编号卡（1013xxxxx / 1002xxxxx）。
 *
 * 这些号正式服卡库没有，卡图 CDN 上也没有；卡图与卡数据由
 * `npm run assets:duel -- --superpre` 落到 duel-assets/ 下（同源，导出长图能画进 canvas）。
 * 登记过的号一律走本地资源，不然会先请求 momobako 404、再请求 ygoprodeck 404。
 */
const superPreIds = new Set<number>()
const superPrePicUrl = (id: number) => `${DUEL_ASSET_BASE}pics/superpre/${id}.jpg`

export function registerSuperPreIds(ids: Iterable<number>): void {
  for (const id of ids) superPreIds.add(id)
}

export const cardImageUrl = (id: number) =>
  superPreIds.has(id)
    ? superPrePicUrl(id)
    : `https://cdn.233.momobako.com/ygopro/pics/${id}.jpg`
/** momobako 缺图时的备用图源（新卡 / 先行卡常见） */
export const cardImageFallback = (id: number) =>
  superPreIds.has(id) ? CARD_PLACEHOLDER : `https://images.ygoprodeck.com/images/cards/${id}.jpg`
/** 备用图源的小图，列表缩略图用，省流量 */
export const cardImageFallbackSmall = (id: number) =>
  superPreIds.has(id) ? CARD_PLACEHOLDER : `https://images.ygoprodeck.com/images/cards_small/${id}.jpg`

/**
 * 卡图的同源地址：dev / preview 由 vite 代理到 momobako，
 * 生产环境用 VITE_CARD_IMG_BASE 指向自己的反代。
 * 只有同源才允许把卡图画进 canvas（导出 GIF）。
 */
export const CARD_IMG_BASE = import.meta.env.VITE_CARD_IMG_BASE || '/pics/'
export const cardImageProxyUrl = (id: number) =>
  superPreIds.has(id) ? superPrePicUrl(id) : `${CARD_IMG_BASE}${id}.jpg`

/** 里侧表示用的标准卡背：ygopro 的 pics 目录里 id 0 就是卡背图 */
export const cardBackImageUrl = `${CARD_IMG_BASE}0.jpg`

/** 卡图缺失时的占位图：自定义卡（先行服 / 未收录）通常没有卡图 */
export const CARD_PLACEHOLDER = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 174">' +
    '<rect width="120" height="174" rx="7" fill="#151b26"/>' +
    '<rect x="7.5" y="7.5" width="105" height="159" rx="5" fill="none" stroke="#2a3446" stroke-width="1.5"/>' +
    '<text x="60" y="94" font-family="sans-serif" font-size="30" fill="#3f4c61" text-anchor="middle">?</text>' +
    '<text x="60" y="118" font-family="sans-serif" font-size="9" fill="#3f4c61" text-anchor="middle">NO IMAGE</text>' +
    '</svg>',
)}`

/**
 * 异画卡在 ygopro 系卡库（EDOPro / YGOPro）里是独立条目，id = 本体密码 + n，
 * 官方卡号本身不变（见 ygopro Card Database 的 alias 规则：|alias - id| 小于
 * CARD_ARTWORK_VERSIONS_OFFSET，DataEditorX 限制差值不超过 9）。
 * 正式服卡库只有本体密码，所以导入 ydk 时要把这些编号折回本体。
 */
export const ALT_ART_ID_SPAN = 9

/**
 * 卡号归一化：本身就是卡库里的卡就原样返回，否则按「本体密码 + 1..9」往上找，
 * 命中就返回本体密码（异画卡），都不命中再原样返回（真正未收录的卡）。
 */
export function normalizeAltArtId(id: number, known: (id: number) => boolean): number {
  if (!(id > 0) || known(id)) return id
  for (let step = 1; step <= ALT_ART_ID_SPAN; step += 1) {
    const base = id - step
    if (base > 0 && known(base)) return base
  }
  return id
}

/** 从卡图 URL 里取出卡号（.../pics/71599345.jpg → 71599345） */
function cardIdFromImageUrl(url: string): number | null {
  const hit = /\/(\d+)\.(?:jpe?g|png|webp)(?:\?.*)?$/i.exec(url)
  if (!hit) return null
  const id = Number(hit[1])
  return id > 0 ? id : null
}

/**
 * 卡图加载失败的两级兜底（由 App.vue 捕获阶段的全局监听调用）：
 *   1. momobako 缺图 → 换 YGOPRODeck（列表缩略图用小图，省流量）
 *   2. YGOPRODeck 也没有 → 换成占位图
 * 自定义卡没有卡号对应的图，直接落到占位图。
 */
export function handleCardImageError(event: Event): void {
  const img = event.target as HTMLImageElement | null
  if (!img || img.tagName !== 'IMG') return
  const step = img.dataset.cardFallback ?? '0'
  if (step === '0') {
    img.dataset.cardFallback = '1'
    const id = cardIdFromImageUrl(img.src)
    if (id === null) {
      img.src = CARD_PLACEHOLDER
      return
    }
    const width = img.clientWidth
    img.src = width > 0 && width <= 72 ? cardImageFallbackSmall(id) : cardImageFallback(id)
    return
  }
  if (step === '1') {
    img.dataset.cardFallback = '2'
    img.src = CARD_PLACEHOLDER
  }
}

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

/**
 * 超先行服（MyCard 超先行）的临时编号卡。
 *
 * 正式服卡库（ygocdb）没有这些号，所以单独由 `assets:duel --superpre` 生成一份
 * `duel-assets/superpre-cards.json`（ygocdb 同格式），这里解析成 CardData 追加进卡库。
 * 拿不到就返回空数组：没有超先行资源时整个卡库照常工作。
 */
export async function loadSuperPreCards(): Promise<CardData[]> {
  try {
    const res = await fetch(`${DUEL_ASSET_BASE}superpre-cards.json`, { cache: 'no-cache' })
    if (!res.ok) return []
    const json = (await res.json()) as { cards?: RawCard[] }
    const cards = (json.cards || []).filter((card) => card && card.id).map(normalizeCard)
    registerSuperPreIds(cards.map((card) => card.id))
    return cards
  } catch {
    return []
  }
}

/** 主卡库 + 超先行卡（同号以主卡库为准） */
async function withSuperPre(cards: CardData[]): Promise<CardData[]> {
  const extra = await loadSuperPreCards()
  if (!extra.length) return cards
  const known = new Set(cards.map((card) => card.id))
  return [...cards, ...extra.filter((card) => !known.has(card.id))]
}

export async function loadCardDatabase(onProgress?: (p: LoadProgress) => void): Promise<CardData[]> {
  const report = (p: LoadProgress) => onProgress?.(p)
  const cached = await idbGet<string>(CACHE_KEY)
  if (cached) {
    try {
      report({ phase: 'parse', loaded: 0, total: 0, message: '读取本地卡库…' })
      const cards = JSON.parse(cached) as CardData[]
      if (Array.isArray(cards) && cards.length > 1000) {
        // 缓存里只有正式服卡库，超先行卡每次从 duel-assets 补（几十 KB，不值得进 IDB）
        const merged = await withSuperPre(cards)
        report({
          phase: 'ready',
          loaded: merged.length,
          total: merged.length,
          message: `本地卡库 ${merged.length} 张`,
        })
        return merged
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
  const merged = await withSuperPre(cards)
  report({
    phase: 'ready',
    loaded: merged.length,
    total: merged.length,
    message: `卡库就绪 · ${merged.length} 张`,
  })
  return merged
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
