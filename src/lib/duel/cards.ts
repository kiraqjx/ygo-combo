import type { OcgCardData } from 'ocgcore-wasm'

/**
 * 内核卡数据（cards.cdb 的紧凑投影）。
 *
 * `duel-assets/cards.json` 由 `npm run assets:duel` 生成：
 *   code → [alias, type, level, attribute, race, attack, defense, lscale, rscale, linkMarker, ot, sc0, sc1, sc2, sc3]
 *
 * 为什么不复用 `stores/cards` 里的 ygocdb 数据：那份只保留展示字段，
 * 没有 alias / 灵摆刻度 / 连接箭头 / setcode，内核调 cardReader 时会缺字段。
 */
type CardTuple = number[]

const TUPLE_LENGTH = 15

export interface DuelCardSource {
  /** 卡号 → 内核卡数据 */
  get(code: number): OcgCardData | null
  has(code: number): boolean
  /** 卡库里查不到的卡（卡组里有但内核不认识） */
  missing(codes: number[]): number[]
}

let sourceCache: DuelCardSource | null = null

/** 读 manifest 里的构建时间当版本号（拿不到就退化成不缓存） */
async function readAssetVersion(base: string): Promise<string> {
  try {
    const res = await fetch(`${base}manifest.json`, { cache: 'no-cache' })
    if (!res.ok) return ''
    const manifest = (await res.json()) as { builtAt?: number }
    return manifest.builtAt ? String(manifest.builtAt) : ''
  } catch {
    return ''
  }
}

function toCardData(code: number, tuple: CardTuple): OcgCardData {
  return {
    code,
    alias: tuple[0],
    // 必须是 uint16 数组：库会把这个数组拷到堆上，再把指针写进 card_data.setcodes。
    // 传打包好的 bigint 时 setcodes.length 是 undefined，库会当成"没有 setcode"，
    // 于是所有 IsSetCard（系列/字段判定）都会失效，比如罪宝狩りの悪魔搜不到黑魔女。
    setcodes: [tuple[11], tuple[12], tuple[13], tuple[14]],
    level: tuple[2],
    attribute: tuple[3],
    race: BigInt(tuple[4]) as OcgCardData['race'],
    attack: tuple[5],
    defense: tuple[6],
    lscale: tuple[7],
    rscale: tuple[8],
    link_marker: tuple[9],
    type: tuple[1],
  } as OcgCardData
}

export async function loadDuelCardSource(base: string): Promise<DuelCardSource> {
  if (sourceCache) return sourceCache

  // 卡数据重建后 URL 必须变，否则浏览器会一直用旧缓存（曾经踩过：新卡被判成"卡库没有"）
  const version = await readAssetVersion(base)
  const url = `${base}cards.json${version ? `?v=${version}` : ''}`
  const res = await fetch(url, { cache: version ? 'default' : 'no-cache' })
  if (!res.ok) {
    throw new Error(`卡数据加载失败（HTTP ${res.status}）。先运行 npm run assets:duel`)
  }
  const json = (await res.json()) as { cards: Record<string, CardTuple> }
  const table = new Map<number, CardTuple>()
  for (const [key, tuple] of Object.entries(json.cards)) {
    if (tuple.length >= TUPLE_LENGTH) table.set(Number(key), tuple)
  }

  const built = new Map<number, OcgCardData>()
  sourceCache = {
    has: (code) => table.has(code),
    missing: (codes) => codes.filter((code) => !table.has(code)),
    get(code) {
      const hit = built.get(code)
      if (hit) return hit
      const tuple = table.get(code)
      if (!tuple) return null
      const card = toCardData(code, tuple)
      built.set(code, card)
      return card
    },
  }
  return sourceCache
}
