#!/usr/bin/env node
/**
 * 下载并生成决斗内核所需资源（一次性脚本，产物不进仓库）：
 *
 *   duel-assets/
 *     scripts/constant.lua 等    公共脚本（utility / proc_* / chain ……）
 *     scripts/official/c*.lua    卡片脚本（一万多个，按需请求）
 *     scripts/helpers.json       公共脚本清单，开局前一次性预载
 *     cards.json                 从 cards.cdb 抽出的内核卡数据（约 800KB）
 *     strings.json               strings.conf 的 !system 提示文案
 *     descriptions.json          每张卡的效果分条（选项名 / 提示名用，约 650KB）
 *     manifest.json              版本信息
 *
 * 资源取自 EDOPro 官方仓库：内核是 edo9300/ygopro-core（ocgcore-wasm 编译），
 * 必须配它自己的脚本（ProjectIgnis/CardScripts）与卡库（ProjectIgnis/BabelCDB），
 * 换成 MyCard 那套会缺 aux.AddFusionProcCodeRep 之类的新版辅助函数。
 *
 * 用法：npm run assets:duel
 *
 * 生产环境把 duel-assets/ 传到静态服务器 / CDN，再用 VITE_DUEL_ASSET_BASE 指过去。
 */
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, '.cache', 'duel')
const OUT = join(ROOT, 'duel-assets')

const SCRIPTS_URL = 'https://codeload.github.com/ProjectIgnis/CardScripts/tar.gz/refs/heads/master'
const DATABASE_URL = 'https://codeload.github.com/ProjectIgnis/BabelCDB/tar.gz/refs/heads/master'
/**
 * 补充卡库：BabelCDB 更新较慢，会缺最新/未发售的卡（比如 24203749、71599345）。
 * 站内卡库来自 ygocdb，而 MyCard 的卡库和它同源，所以用它补齐 BabelCDB 里没有的卡号。
 * 冲突时以 BabelCDB 为准（它才和内核脚本配套）。
 */
const SUPPLEMENT_URL = 'https://codeload.github.com/mycard/ygopro-database/tar.gz/refs/heads/master'
const SUPPLEMENT_REL = 'ygopro-database-master/locales/zh-CN/cards.cdb'

/**
 * 效果分条的手工修正（卡号 → str1..strN）。
 *
 * 中文库还没同步脚本新加的选项时，直接用这里的文案，避免界面显示错位的选项名。
 * 45171524「巳剑劝请」：脚本第 5 条是「两者都适用」，中文库还停在旧的
 * 「是否特殊召唤？」，导致解放怪兽后看不出可以两个效果都选。
 */
const DESCRIPTION_FIXES = {
  45171524: [
    '发动',
    '是否解放怪兽来发动？',
    '是否从卡组加入手卡？',
    '是否受到伤害？',
    '两者都适用',
    '是否特殊召唤？',
  ],
}

/** 卡种位（ocgcore 的 TYPE_* ） */
const TYPE_PENDULUM = 0x1000000
const TYPE_LINK = 0x4000000

function log(message) {
  process.stdout.write(`${message}\n`)
}

function humanSize(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024).toFixed(0)}KB`
}

async function download(url, file) {
  if (existsSync(file) && statSync(file).size > 1024) {
    log(`· 复用缓存 ${file.split('/').pop()}（${humanSize(statSync(file).size)}）`)
    return
  }
  mkdirSync(dirname(file), { recursive: true })
  log(`↓ 下载 ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`)
  await new Promise((ok, fail) => {
    const stream = createWriteStream(file)
    res.body.pipeTo(new WritableStream({
      write(chunk) {
        stream.write(chunk)
      },
      close() {
        stream.end(ok)
      },
      abort(err) {
        fail(err)
      },
    })).catch(fail)
  })
  log(`  完成 ${humanSize(statSync(file).size)}`)
}

function extract(tarball, dest, options = []) {
  mkdirSync(dest, { recursive: true })
  execFileSync('tar', ['xzf', tarball, '-C', dest, ...options], { stdio: 'inherit' })
}

/**
 * 读一个 cards.cdb，返回 code → 内核卡数据数组。
 *
 * 数组顺序：[alias, type, level, attribute, race, attack, defense, lscale, rscale, linkMarker, ot, sc0..sc3]
 * 必须和 src/lib/duel/cards.ts 里的解析顺序一致。
 */
function readCdb(cdbPath) {
  let DatabaseSync
  try {
    ;({ DatabaseSync } = require('node:sqlite'))
  } catch {
    throw new Error('需要 Node 22+ 的 node:sqlite 才能读取 cards.cdb')
  }
  const db = new DatabaseSync(cdbPath, { readOnly: true })
  // setcode 是 64 位整数，JSON 表示不了，直接让 sqlite 拆成 4 个 uint16
  const rows = db
    .prepare(
      `SELECT id, alias, type, atk, def, level, race, attribute,
              setcode & 0xffff AS sc0,
              (setcode >> 16) & 0xffff AS sc1,
              (setcode >> 32) & 0xffff AS sc2,
              (setcode >> 48) & 0xffff AS sc3
       FROM datas`,
    )
    .all()
  db.close()

  const cards = new Map()
  for (const row of rows) {
    const type = row.type | 0
    let level = row.level | 0
    let defense = row.def | 0
    let lscale = 0
    let rscale = 0
    let linkMarker = 0

    if (type & TYPE_PENDULUM) {
      // 灵摆：level 高字节打包左右刻度
      lscale = (level >>> 24) & 0xff
      rscale = (level >>> 16) & 0xff
      level &= 0xff
    } else if (type & TYPE_LINK) {
      // 连接：def 存箭头掩码，level 存连接数
      linkMarker = defense & 0xff
      defense = 0
      level &= 0xff
    } else {
      level &= 0xff
    }

    cards.set(row.id, [
      row.alias | 0,
      type,
      level,
      row.attribute | 0,
      row.race | 0,
      row.atk | 0,
      defense,
      lscale,
      rscale,
      linkMarker,
      0,
      row.sc0 | 0,
      row.sc1 | 0,
      row.sc2 | 0,
      row.sc3 | 0,
    ])
  }
  return cards
}

/** 主卡库优先，补充卡库只补缺失的卡号 */
function mergeCards(basePath, supplementPath) {
  const merged = readCdb(basePath)
  const baseCount = merged.size
  let extra = 0
  for (const [code, data] of readCdb(supplementPath)) {
    if (merged.has(code)) continue
    merged.set(code, data)
    extra += 1
  }
  log(`· 主卡库 ${baseCount} 张，补充 ${extra} 张`)
  return Object.fromEntries([...merged.entries()].sort((a, b) => a[0] - b[0]))
}

/**
 * 读 cards.cdb 的 texts 表，返回 code → 效果分条（str1..strN）。
 *
 * 脚本里 `aux.Stringid(code, n)` 生成的描述 id 是 `code << 20 | n`，
 * 客户端拿这里的第 n 条当选项名，否则界面上只能显示「选项 1 / 选项 2」。
 *
 * 中文库在前（翻译好），BabelCDB 只补中文库缺的卡。中文库的分条偶尔落后于
 * CardScripts（脚本加选项后序号会整体错位，例如「两者都适用」被顶成
 * 「是否特殊召唤？」），这类无法从数据本身判断的错位用 DESCRIPTION_FIXES 手工修。
 */
function readDescriptions(paths) {
  let DatabaseSync
  try {
    ;({ DatabaseSync } = require('node:sqlite'))
  } catch {
    log('· 跳过效果分条：需要 Node 22+ 的 node:sqlite')
    return {}
  }
  const columns = Array.from({ length: 16 }, (_, index) => `str${index + 1}`).join(', ')
  const table = {}
  for (const path of paths) {
    if (!existsSync(path)) continue
    const db = new DatabaseSync(path, { readOnly: true })
    const rows = db.prepare(`SELECT id, ${columns} FROM texts`).all()
    db.close()
    for (const row of rows) {
      if (table[row.id]) continue
      const list = []
      for (let index = 0; index < 16; index += 1) {
        const text = row[`str${index + 1}`]
        list.push(typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '')
      }
      while (list.length && !list[list.length - 1]) list.pop()
      if (list.length) table[row.id] = list
    }
  }
  for (const [code, list] of Object.entries(DESCRIPTION_FIXES)) table[code] = list
  return table
}

/** strings.conf 里只取 !system 行：id → 文本 */
function parseStrings(file) {
  const table = {}
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('!system ')) continue
    const match = /^!system\s+(\d+)\s+(.+)$/.exec(line)
    if (match) table[Number(match[1])] = match[2].trim()
  }
  return table
}

async function main() {
  mkdirSync(CACHE, { recursive: true })
  mkdirSync(OUT, { recursive: true })

  const scriptsTar = join(CACHE, 'card-scripts.tar.gz')
  const dbTar = join(CACHE, 'babel-cdb.tar.gz')
  const supplementTar = join(CACHE, 'mycard-cdb.tar.gz')
  await download(SCRIPTS_URL, scriptsTar)
  await download(DATABASE_URL, dbTar)
  await download(SUPPLEMENT_URL, supplementTar)

  // 脚本：tar 里的顶层目录名不固定，直接去掉第一层
  const scriptsDir = join(OUT, 'scripts')
  if (!existsSync(join(scriptsDir, 'constant.lua'))) {
    rmSync(scriptsDir, { recursive: true, force: true })
    log('… 解压卡片脚本')
    extract(scriptsTar, scriptsDir, ['--strip-components=1'])
  }
  const cardScriptCount = existsSync(join(scriptsDir, 'official'))
    ? readdirSync(join(scriptsDir, 'official')).filter((name) => name.endsWith('.lua')).length
    : 0
  // 根目录下的公共脚本（constant / utility / proc_* ……）开局前全部预载
  const helpers = readdirSync(scriptsDir)
    .filter((name) => name.endsWith('.lua'))
    .sort()
  writeFileSync(join(scriptsDir, 'helpers.json'), JSON.stringify(helpers))
  log(`· 公共脚本 ${helpers.length} 个，卡片脚本 ${cardScriptCount} 个`)

  // 卡库（主 + 补充）
  const cdbRel = 'BabelCDB-master/cards.cdb'
  const cdbPath = join(CACHE, cdbRel)
  if (!existsSync(cdbPath)) {
    log('… 解压卡库')
    extract(dbTar, CACHE, [cdbRel])
  }
  const supplementPath = join(CACHE, SUPPLEMENT_REL)
  if (!existsSync(supplementPath)) {
    log('… 解压补充卡库')
    extract(supplementTar, CACHE, [SUPPLEMENT_REL])
  }

  // 提示文本：内核 MSG_HINT 里给的是 "/system" 字符串 id，靠 strings.conf 翻译
  const stringsRel = 'ygopro-database-master/locales/zh-CN/strings.conf'
  const stringsPath = join(CACHE, stringsRel)
  if (!existsSync(stringsPath)) {
    log('… 解压 strings.conf')
    extract(supplementTar, CACHE, [stringsRel])
  }
  log('… 生成 strings.json')
  const system = parseStrings(stringsPath)
  writeFileSync(join(OUT, 'strings.json'), JSON.stringify({ system }))
  log(`· 提示文本 ${Object.keys(system).length} 条`)

  log('… 生成 cards.json')
  const cards = mergeCards(cdbPath, supplementPath)
  const json = JSON.stringify({ version: 1, cards })
  writeFileSync(join(OUT, 'cards.json'), json)
  log(`· 卡数据 ${Object.keys(cards).length} 张，${humanSize(Buffer.byteLength(json))}`)

  log('… 生成 descriptions.json')
  const descriptions = readDescriptions([supplementPath, cdbPath])
  const descriptionJson = JSON.stringify({ descriptions })
  writeFileSync(join(OUT, 'descriptions.json'), descriptionJson)
  log(`· 效果分条 ${Object.keys(descriptions).length} 张，${humanSize(Buffer.byteLength(descriptionJson))}`)

  writeFileSync(
    join(OUT, 'manifest.json'),
    JSON.stringify({ helpers: helpers.length, cardScripts: cardScriptCount, cards: Object.keys(cards).length, builtAt: Date.now() }, null, 2),
  )
  log(`\n完成：${OUT}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
