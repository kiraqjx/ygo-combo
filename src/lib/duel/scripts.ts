/**
 * 决斗内核的 Lua 脚本仓。
 *
 * 目录布局和 EDOPro 一致：
 *   scripts/constant.lua、utility.lua、proc_*.lua   公共脚本
 *   scripts/official/c<卡号>.lua                    卡片脚本
 *   scripts/superpre/c<临时编号>.lua                超先行服（MyCard）临时编号卡的脚本
 *
 * ocgcore 索要脚本时只给名字（`c12345678.lua`），卡片脚本要去 official/ 下找。
 * 同步版内核要求 reader 立即返回内容，所以开局前把公共脚本与两套卡组用到的
 * 卡片脚本预先拉回来；异步（JSPI）内核下漏掉的脚本才按需加载。
 */
export const DUEL_ASSET_BASE = `${(import.meta.env.VITE_DUEL_ASSET_BASE || '/duel-assets/').replace(/\/+$/, '')}/`

const CARD_SCRIPT = /^c\d+\.lua$/

/**
 * 上游没有脚本时的占位脚本。
 *
 * 不给脚本的话，内核每次初始化这张卡都会抛 "attempt to call an error function"，
 * 一场对局能刷出几十条；给个空实现就干净了 —— 卡依旧没有效果，
 * 但"没有效果"这件事由界面上的黄条提示，不靠内核对喷。
 */
const EMPTY_CARD_SCRIPT = '-- 缺官方脚本的占位：保证内核不报错，卡本身没有效果\nlocal s,id=GetID()\nfunction s.initial_effect(c) end\n'
/** 这两个必须先于 proc_* 加载，其余公共脚本依赖它们建立的 aux 表 */
const CORE_SCRIPTS = ['constant.lua', 'utility.lua']
/** 先行服脚本的兼容垫片（覆盖 GetID / 补常量），必须排在所有公共脚本之后 */
const COMPAT_SCRIPT = 'mycard-compat.lua'
/**
 * 超先行 / 先行服兼容层，顺序写死不能改：
 *   快照 EDOPro 的 aux 表 → 加载 MyCard 的 utility.lua（它会 `Auxiliary={}` 清空整表）
 *   → 把 EDOPro 的实现还原回去 → 补上 MyCard 的 procedure.lua（缺的召唤手续辅助函数）。
 * 详见 scripts/fetch-duel-assets.mjs 里 copyMycardHelpers 的说明。
 */
const SUPER_PRE_HELPERS = [
  'mycard-snapshot.lua',
  'mycard-utility.lua',
  'mycard-restore.lua',
  'mycard-procedure.lua',
]
const FALLBACK_HELPERS = [...CORE_SCRIPTS, 'proc_normal.lua', 'proc_fusion.lua', 'proc_synchro.lua', 'proc_xyz.lua', 'proc_link.lua', 'proc_pendulum.lua', 'proc_ritual.lua']

const CONCURRENCY = 8

export interface ScriptPreloadResult {
  loaded: number
  /** 服务端没有的脚本（普通怪兽没有 c<code>.lua，属正常） */
  absent: string[]
}

export class ScriptStore {
  private readonly map = new Map<string, string | null>()
  private helperNames: string[] | null = null
  /** 上游确实没有脚本的卡号（内核里用空脚本兜住，界面据此提示） */
  readonly missingCodes = new Set<number>()
  private version: string | null = null
  private versionPromise: Promise<string> | null = null

  constructor(private readonly base = DUEL_ASSET_BASE) {}

  /**
   * 资源版本号（manifest.json 的 builtAt）。
   *
   * 不带版本号时脚本 URL 是固定的，浏览器按 cache-control 还能缓存一天 ——
   * 重新跑 assets:duel 补了脚本 / 改了兼容垫片，页面却还在跑旧文件（表现为
   * "明明补了还是不行"）。带上版本号后，中间件会按 immutable 长缓存处理，重建即失效。
   */
  private async assetVersion(): Promise<string> {
    if (this.version !== null) return this.version
    if (!this.versionPromise) {
      this.versionPromise = (async () => {
        try {
          const res = await fetch(`${this.base}manifest.json`, { cache: 'no-cache' })
          if (res.ok) {
            const manifest = (await res.json()) as { builtAt?: number }
            if (manifest.builtAt) return String(manifest.builtAt)
          }
        } catch {
          /* 拿不到就不带版本号 */
        }
        return ''
      })()
    }
    this.version = await this.versionPromise
    return this.version
  }

  /** 公共脚本清单（开局前会被逐个 loadScript） */
  async helpers(): Promise<string[]> {
    if (this.helperNames) return this.helperNames
    let names = FALLBACK_HELPERS
    try {
      const version = await this.assetVersion()
      const res = await fetch(`${this.base}scripts/helpers.json${version ? `?v=${version}` : ''}`)
      if (res.ok) {
        const list = (await res.json()) as string[]
        if (Array.isArray(list) && list.length) names = list
      }
    } catch {
      /* 拿不到清单就用兜底列表 */
    }
    // constant / utility 必须最先加载；兼容层紧跟其后、兼容垫片最后（它要拿 utility 里的 GetID）
    const reserved = new Set([...CORE_SCRIPTS, ...SUPER_PRE_HELPERS, COMPAT_SCRIPT])
    const rest = names.filter((name) => !reserved.has(name))
    const compatLayer = SUPER_PRE_HELPERS.filter((name) => names.includes(name))
    const compat = names.includes(COMPAT_SCRIPT) ? [COMPAT_SCRIPT] : []
    this.helperNames = [...CORE_SCRIPTS, ...rest, ...compatLayer, ...compat]
    return this.helperNames
  }

  /** 已加载的脚本，同步版内核用 */
  getSync(name: string): string | null {
    return this.map.get(normalizeName(name)) ?? null
  }

  /** 按需加载（异步内核用） */
  async load(name: string): Promise<string | null> {
    const key = normalizeName(name)
    if (this.map.has(key)) return this.map.get(key) ?? null
    const text = await this.fetchOne(key)
    this.map.set(key, text)
    return text
  }

  async preload(codes: number[]): Promise<ScriptPreloadResult> {
    const helpers = await this.helpers()
    const names = [...helpers, ...codes.map((code) => `c${code}.lua`)]
    const absent: string[] = []
    let loaded = 0
    let cursor = 0

    const worker = async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= names.length) return
        const name = names[index]
        if (this.map.has(name)) continue
        const text = await this.fetchOne(name)
        this.map.set(name, text)
        if (text === null) absent.push(name)
        else loaded += 1
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, names.length) }, worker))
    return { loaded, absent }
  }

  private async fetchOne(name: string): Promise<string | null> {
    // 卡片脚本在 official/；旧裁定、未发售、非官方的在 pre-release / mycard / unofficial / pre-errata，
    // 按"越正经越优先"的顺序兜底，总比没有脚本（卡直接变成白板）好。
    // mycard/ 是先行服（MyCard 领先于 CardScripts 收录）的脚本，由 npm run assets:duel 维护。
    // local/ 是手工补丁位：上游还没写脚本的新卡（刚公布、还没发售的卡）把 c<卡号>.lua 丢进去即可，
    // 优先级最高，assets:duel 不会删它（见 README「数据来源」）。
    // superpre/ 是超先行服（MyCard 超先行）的临时编号脚本，由 assets:duel --superpre 生成，
    // 里面只有 1013xxxxx / 1002xxxxx 这类正式库没有的号，不会和 official/ 撞。
    const paths = CARD_SCRIPT.test(name)
      ? [
          `local/${name}`,
          `superpre/${name}`,
          `official/${name}`,
          `pre-release/${name}`,
          `mycard/${name}`,
          `unofficial/${name}`,
          `pre-errata/${name}`,
        ]
      : [name]
    const version = await this.assetVersion()
    const suffix = version ? `?v=${version}` : ''
    for (const relative of paths) {
      try {
        const res = await fetch(`${this.base}scripts/${relative}${suffix}`)
        if (res.ok) return await res.text()
      } catch {
        /* 试下一个位置 */
      }
    }

    const code = Number(/^c(\d+)\.lua$/.exec(name)?.[1] ?? 0)
    if (code > 0) {
      this.missingCodes.add(code)
      return EMPTY_CARD_SCRIPT
    }
    return null
  }
}

/** 内核偶尔会带上目录前缀，统一成脚本目录下的相对路径 */
function normalizeName(name: string): string {
  const clean = name.replace(/\\/g, '/').replace(/^\.?\//, '')
  const slash = clean.lastIndexOf('/')
  return slash >= 0 ? clean.slice(slash + 1) : clean
}
