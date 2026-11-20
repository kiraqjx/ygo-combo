/**
 * 全站数据备份 / 恢复。
 *
 * 站点没有后端，所有东西都在浏览器里：localStorage 存卡组、手坑、主题、
 * skill 包、暂存与 AI 配置，IndexedDB 存录像（`ygo-skill`）与卡库缓存
 * （`ygo-infer`）。换设备、清缓存、换浏览器都会丢，所以给一个一键备份。
 *
 * 两条边界：
 *   - **API Key 不导出**（防泄漏），导入时也不会覆盖本机已有的密钥；
 *   - **卡库缓存不导出**（十几 MB，随时能从 ygocdb 重新下载），导入时也不动它。
 *
 * 导入的语义是「覆盖」：备份里有的 key 直接盖掉，备份的库整表清空后重写。
 */

/** 备份格式版本；结构不兼容时 +1（旧文件会被拒绝，而不是导入一半） */
export const SITE_BACKUP_VERSION = 1

const BACKUP_KIND = 'ygo-combo-backup'

/** 参与备份的 localStorage key（白名单，避免把别的东西带出去） */
export const LOCAL_KEYS = [
  'ygo-deck-builder-v2',
  'ygo-infer-handtraps-v1',
  'ygo-combo:custom-cards-v1',
  'ygo-skill-bundles',
  'ygo-duel-checkpoints',
  'ygo-infer-theme',
  'ygo-ai-config',
] as const

const AI_CONFIG_KEY = 'ygo-ai-config'
/** 录像库：卡库缓存（ygo-infer）故意不在列表里 */
const REPLAY_DB = 'ygo-skill'

/** 二进制标记：JSON 里靠它和普通对象区分开 */
const BIN_TAG = '__ygoBin'

interface IndexDump {
  name: string
  keyPath: string | string[]
  unique: boolean
  multiEntry: boolean
}

interface StoreDump {
  name: string
  keyPath: string | string[] | null
  autoIncrement: boolean
  indexes: IndexDump[]
  records: { key: IDBValidKey | null; value: unknown }[]
}

interface DbDump {
  name: string
  version: number
  stores: StoreDump[]
}

export interface SiteBackup {
  kind: typeof BACKUP_KIND
  version: number
  exportedAt: string
  localStorage: Record<string, string>
  databases: DbDump[]
}

export interface ImportResult {
  keys: number
  replays: number
}

/* ------------------------------------------------------------------ */
/* 二进制编解码（录像字节是 Uint8Array，JSON.stringify 会变成数字下标的对象） */
/* ------------------------------------------------------------------ */

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  // 分块，避免 String.fromCharCode(...bigArray) 爆栈
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function encodeBinary(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [BIN_TAG]: 'u8', data: toBase64(value) }
  if (value instanceof ArrayBuffer) return { [BIN_TAG]: 'ab', data: toBase64(new Uint8Array(value)) }
  if (Array.isArray(value)) return value.map(encodeBinary)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = encodeBinary(item)
    }
    return out
  }
  return value
}

function decodeBinary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeBinary)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const tag = record[BIN_TAG]
    if (tag === 'u8' && typeof record.data === 'string') return fromBase64(record.data)
    if (tag === 'ab' && typeof record.data === 'string') {
      return fromBase64(record.data).buffer
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) out[key] = decodeBinary(item)
    return out
  }
  return value
}

/* ------------------------------------------------------------------ */
/* IndexedDB                                                          */
/* ------------------------------------------------------------------ */

function openDb(name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version ? indexedDB.open(name, version) : indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error(`打不开数据库 ${name}`))
    request.onblocked = () => reject(new Error('数据库被其他标签页占用，先关掉本站的其它标签页'))
  })
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function stringList(list: DOMStringList): string[] {
  return Array.from(list)
}

/** 读一个库的全部 store（不存在就返回空库，不报错） */
async function readDb(name: string, only?: string[]): Promise<DbDump | null> {
  let db: IDBDatabase
  try {
    db = await openDb(name)
  } catch {
    return null
  }
  try {
    const stores: StoreDump[] = []
    for (const storeName of stringList(db.objectStoreNames)) {
      if (only && !only.includes(storeName)) continue
      const os = db.transaction(storeName, 'readonly').objectStore(storeName)
      const [values, keys] = await Promise.all([
        requestToPromise(os.getAll()),
        requestToPromise(os.getAllKeys()),
      ])
      stores.push({
        name: storeName,
        keyPath: os.keyPath,
        autoIncrement: os.autoIncrement,
        indexes: stringList(os.indexNames).map((indexName) => {
          const index = os.index(indexName)
          return {
            name: index.name,
            keyPath: index.keyPath as string | string[],
            unique: index.unique,
            multiEntry: index.multiEntry,
          }
        }),
        records: values.map((value, position) => ({
          key: (keys[position] as IDBValidKey | undefined) ?? null,
          // 录像里有 Uint8Array，先转成 base64 再把整份备份 JSON 化
          value: encodeBinary(value),
        })),
      })
    }
    return { name, version: db.version, stores }
  } finally {
    db.close()
  }
}

/** 打开写库：库/表不存在时按备份里的结构补建（换新浏览器也能恢复） */
async function openDbForWrite(dump: DbDump): Promise<IDBDatabase> {
  const db = await openDb(dump.name)
  const missing = dump.stores.filter((store) => !db.objectStoreNames.contains(store.name))
  if (!missing.length) return db

  const version = db.version + 1
  db.close()
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dump.name, version)
    request.onupgradeneeded = () => {
      const upgrading = request.result
      for (const store of dump.stores) {
        const os = upgrading.objectStoreNames.contains(store.name)
          ? request.transaction!.objectStore(store.name)
          : upgrading.createObjectStore(store.name, {
              keyPath: store.keyPath ?? undefined,
              autoIncrement: store.autoIncrement,
            })
        for (const index of store.indexes ?? []) {
          if (os.indexNames.contains(index.name)) continue
          os.createIndex(index.name, index.keyPath, {
            unique: index.unique,
            multiEntry: index.multiEntry,
          })
        }
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error(`建库失败 ${dump.name}`))
  })
}

async function writeDb(dump: DbDump): Promise<number> {
  const db = await openDbForWrite(dump)
  let count = 0
  try {
    for (const store of dump.stores) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store.name, 'readwrite')
        const os = tx.objectStore(store.name)
        os.clear()
        for (const record of store.records) {
          const value = decodeBinary(record.value)
          if (store.keyPath === null) {
            if (record.key === null) continue
            os.put(value, decodeBinary(record.key) as IDBValidKey)
          } else {
            os.put(value)
          }
          count += 1
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    }
    return count
  } finally {
    db.close()
  }
}

/* ------------------------------------------------------------------ */
/* 导出 / 导入                                                        */
/* ------------------------------------------------------------------ */

/** 备份里的 AI 配置一律抹掉密钥 */
function stripApiKey(raw: string): string {
  try {
    const config = JSON.parse(raw) as Record<string, unknown>
    config.apiKey = ''
    return JSON.stringify(config)
  } catch {
    return raw
  }
}

/** 导入时保留本机已有的密钥：备份里这条本来就是空的 */
function mergeApiKey(raw: string): string {
  try {
    const incoming = JSON.parse(raw) as Record<string, unknown>
    if (!incoming.apiKey) {
      const current = JSON.parse(localStorage.getItem(AI_CONFIG_KEY) || '{}') as Record<
        string,
        unknown
      >
      if (typeof current.apiKey === 'string' && current.apiKey) incoming.apiKey = current.apiKey
    }
    return JSON.stringify(incoming)
  } catch {
    return raw
  }
}

export async function buildSiteBackup(): Promise<SiteBackup> {
  const local: Record<string, string> = {}
  for (const key of LOCAL_KEYS) {
    const raw = localStorage.getItem(key)
    if (raw === null) continue
    local[key] = key === AI_CONFIG_KEY ? stripApiKey(raw) : raw
  }

  const databases: DbDump[] = []
  const replays = await readDb(REPLAY_DB, ['replays'])
  if (replays) databases.push(replays)

  return {
    kind: BACKUP_KIND,
    version: SITE_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    localStorage: local,
    databases,
  }
}

/** 覆盖式导入。调用方负责在成功后刷新页面，让内存里的 store 重新读盘 */
export async function importSiteBackup(text: string): Promise<ImportResult> {
  let data: SiteBackup
  try {
    data = JSON.parse(text) as SiteBackup
  } catch {
    throw new Error('不是合法的 JSON 文件')
  }
  if (!data || data.kind !== BACKUP_KIND) throw new Error('这不是本站导出的备份文件')
  if (typeof data.version !== 'number' || data.version > SITE_BACKUP_VERSION) {
    throw new Error('备份文件版本过新，先刷新页面升级后再导入')
  }

  let keys = 0
  for (const [key, value] of Object.entries(data.localStorage ?? {})) {
    if (typeof value !== 'string') continue
    if (!(LOCAL_KEYS as readonly string[]).includes(key)) continue
    try {
      localStorage.setItem(key, key === AI_CONFIG_KEY ? mergeApiKey(value) : value)
      keys += 1
    } catch {
      // 配额满了只影响这一项，继续导其余部分
    }
  }

  let replays = 0
  for (const dump of data.databases ?? []) {
    if (!dump || dump.name !== REPLAY_DB) continue
    replays += await writeDb(dump)
  }

  return { keys, replays }
}

/** 备份文件名：ygo-combo-备份-20261120-1530.json */
export function backupFileName(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}`
  return `ygo-combo-备份-${stamp}.json`
}
