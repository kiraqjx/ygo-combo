#!/usr/bin/env node
/**
 * 下载并生成决斗内核所需资源（一次性脚本，产物不进仓库）：
 *
 *   duel-assets/
 *     scripts/constant.lua 等    公共脚本（utility / proc_* / chain ……）
 *     scripts/official/c*.lua    卡片脚本（一万多个，按需请求）
 *     scripts/mycard/c*.lua      先行服（MyCard）先行卡脚本，CardScripts 还没收录的那些
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
 * 先行卡（MyCard 先行服已经能打、KONAMI 还没正式发售的卡）CardScripts 里没有脚本，
 * 这类卡在对战区会变成白板，所以额外从 mycard/ygopro-scripts 补一层：
 * 只抄 CardScripts 没收录、且不依赖 MyCard 私有辅助函数（aux.bfgcost 等）的脚本，
 * 放进 scripts/mycard/，由 ScriptStore 在 official / pre-release 之后兜底。
 *
 * 用法：npm run assets:duel
 *
 * 生产环境把 duel-assets/ 传到静态服务器 / CDN，再用 VITE_DUEL_ASSET_BASE 指过去。
 */
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { inflateRawSync } from 'node:zlib'
import { unzipSync } from 'fflate'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, '.cache', 'duel')
const OUT = join(ROOT, 'duel-assets')
/** `npm run assets:duel -- --refresh` 强制重新拉上游（默认复用 .cache 里的 tar / zip） */
const REFRESH = process.argv.includes('--refresh')

/** 取 `--name=value` 形式的参数（可重复） */
function argValues(name) {
  const prefix = `--${name}=`
  return process.argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length))
}
/** `--edopro=<本地目录>`：递归扫描 EDOPro 安装目录 / 先行卡补丁解压目录，补齐上游还没收录的卡（可重复） */
const EDOPRO_DIRS = argValues('edopro')
/** `--scripts-from=<tar.gz / zip 地址>`：从任意脚本包补齐上游还没收录的卡（可重复） */
const EXTRA_SCRIPT_URLS = argValues('scripts-from')
/**
 * `--superpre`：从 MC 超先行服（mycard.world 的 arena 页面用的那套）补脚本。
 * 超先行服给还没定正式密码的卡用 1013xxxxx 这类临时编号，脚本也是 c<临时编号>.lua；
 * 这里按「中文卡名」把临时编号对到站点卡库的正式卡号，改名后写进 local/。
 */
const USE_SUPER_PRE = process.argv.includes('--superpre')
const SUPER_PRE_BASE = 'https://cdntx.moecube.com/ygopro-super-pre'

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
 * 先行服脚本：MyCard 客户端跑的脚本仓库，比 CardScripts 早收录先行卡
 * （盈彩月夜 / 异解△ / 光器 / 塞尼特 / 归光 这类还没正式发售的系列）。
 * 它的脚本依赖 MyCard 自己的公共脚本，所以只挑不引用私有辅助函数的那些。
 */
const MYCARD_SCRIPTS_URL = 'https://codeload.github.com/mycard/ygopro-scripts/tar.gz/refs/heads/master'
/** 兼容垫片的文件名：顶层公共脚本，由 ScriptStore 排在所有公共脚本之后加载 */
const MYCARD_COMPAT = 'mycard-compat.lua'
/**
 * MyCard 脚本与 EDOPro 公共脚本的差异兜底。
 *
 * 1. MyCard 的 GetID() 返回第三个值（回合限制 key 的偏移：id < 1e8 时 1，否则 100），
 *    脚本里写 `id+o`；EDOPro 的 GetID 只返回两个值，o 是 nil 会在注册阶段直接报
 *    「attempt to perform arithmetic on a nil value」。覆盖成三值版对 EDOPro 自己的
 *    脚本无害（它们只取前两个返回值）。
 * 2. 下面几个常量 EDOPro 的 constant.lua 里没有，取值照抄
 *    mycard/ygopro-scripts/constant.lua。它们只影响效果分类位、提示文案与召唤值，
 *    不改规则本身；同名常量已存在时保留原值。
 */
const MYCARD_COMPAT_SOURCE = `-- 由 npm run assets:duel 生成，重跑会覆盖，不要手改。
local compatGetID = GetID
function GetID()
\tlocal s, id = compatGetID()
\treturn s, id, id < 100000000 and 1 or 100
end

-- MyCard 的 category 编码和 EDOPro 大体一致，只有两处真冲突：
--   0x800     MyCard=GRAVE_ACTION   EDOPro=FLIP
--   0x8000000 MyCard=GRAVE_SPSUMMON EDOPro=LVCHANGE
-- 撞位只会让「效果分类」显示错（不影响规则），但既然能选，就置 0：宁可少一个分类，
-- 也不要把除外效果标成翻面。
CATEGORY_GRAVE_SPSUMMON = 0
CATEGORY_GRAVE_ACTION = 0
CATEGORY_DECK_SPSUMMON = 0
-- 这几个不冲突，照 MyCard 的值补
CATEGORY_HANDES_SELF = CATEGORY_HANDES_SELF or 0x80
CATEGORY_HANDES_OPPO = CATEGORY_HANDES_OPPO or 0x400000000
CATEGORY_MSET = CATEGORY_MSET or 0x100000000
CATEGORY_SSET = CATEGORY_SSET or 0x200000000
SUMMON_VALUE_SELF = SUMMON_VALUE_SELF or 0x1
EFFECT_ADD_CARD_TYPE = EFFECT_ADD_CARD_TYPE or 377
HINTMSG_OPERATECARD = HINTMSG_OPERATECARD or 574
TRUE = TRUE or true
-- 超先行 / 先行服脚本用到、EDOPro 的 constant.lua 里没有的常量（值取自 MyCard 的 constant.lua）。
-- 写成独立赋值行：assets:duel 的 missingConstants 靠这个格式判断「已定义」，否则这些脚本会被当成缺依赖跳过。
HINTMSG_DISABLE = HINTMSG_DISABLE or 573
EFFECT_FLAG_FUSION_SUMMON = EFFECT_FLAG_FUSION_SUMMON or 0x400000000
EFFECT_FLAG_DICE = EFFECT_FLAG_DICE or 0x200000000
EFFECT_FLAG_COIN = EFFECT_FLAG_COIN or 0x100000000
EFFECT_EXTRA_LINK_MATERIAL = EFFECT_EXTRA_LINK_MATERIAL or 358
EFFECT_CHANGE_INVOLVING_BATTLE_DAMAGE = EFFECT_CHANGE_INVOLVING_BATTLE_DAMAGE or 314
TYPES_EFFECT_TRAP_MONSTER = TYPES_EFFECT_TRAP_MONSTER or 0x121
FLAG_ID_CHAINING = FLAG_ID_CHAINING or 1
SUMMON_TYPE_ADVANCE = SUMMON_TYPE_ADVANCE or 0x11000000
EVENT_LEAVE_DECK = EVENT_LEAVE_DECK or 1032

-- MyCard 内核内置、Lua 侧却没有的 Card.* 判定（EDOPro 内核压根没有这些方法）。
-- 超先行 / 先行服脚本大量在用，典型是「龙魔导降灵师」的
--   aux.AddLinkProcedure(c, aux.FilterBoolFunction(Card.IsLinkType, TYPE_EFFECT), 2)
-- 缺了它不会在初始化时报错（FilterBoolFunction 只是把它包起来），而是等到求值召唤条件时
-- 「attempt to call a nil value」—— 表现就是这张卡点了没反应、不能 Link / 融合召唤。
-- 语义按 EDOPro 对应的基础判定实现：素材合法性本身由 IsCanBeLinkMaterial / 融合素材检查兜底，
-- 这里只负责「种类 / 属性 / 种族 / 卡号 / 字段」这一层过滤。
if Card.IsLinkType == nil then
\tCard.IsLinkType = function(c, t) return c:IsType(t) end
end
if Card.IsLinkAttribute == nil then
\tCard.IsLinkAttribute = function(c, a) return c:IsAttribute(a) end
end
if Card.IsLinkRace == nil then
\tCard.IsLinkRace = function(c, r) return c:IsRace(r) end
end
if Card.IsLinkCode == nil then
\tCard.IsLinkCode = function(c, code) return c:IsCode(code) end
end
if Card.IsLinkSetCard == nil then
\tCard.IsLinkSetCard = function(c, code) return c:IsSetCard(code) end
end
if Card.IsFusionType == nil then
\tCard.IsFusionType = function(c, t) return c:IsType(t) end
end
if Card.IsFusionAttribute == nil then
\tCard.IsFusionAttribute = function(c, a) return c:IsAttribute(a) end
end
if Card.IsFusionRace == nil then
\tCard.IsFusionRace = function(c, r) return c:IsRace(r) end
end
if Card.IsFusionCode == nil then
\tCard.IsFusionCode = function(c, code) return c:IsCode(code) end
end
if Card.IsFusionSetCard == nil then
\tCard.IsFusionSetCard = function(c, code) return c:IsSetCard(code) end
end

-- 新版 CardScripts 改名或删掉的辅助函数，MyCard / 超先行的脚本还在用旧名字。
-- IsCodeListed 在 deprecated_functions.lua 里被换成了「调用即报错」的桩，必须直接覆盖。

-- MyCard 用 card_code_list 记「效果文本里记述的卡名」，EDOPro 用 listed_names，
-- 查的是同一件事。这里用一张弱表旁挂，两边都能查到。
local mycardCodeList = setmetatable({}, { __mode = 'k' })
aux.AddCodeList = function(c, ...)
\tif c:IsStatus(STATUS_COPYING_EFFECT) then return end
\tlocal list = mycardCodeList[c]
\tif not list then
\t\tlist = {}
\t\tmycardCodeList[c] = list
\tend
\tfor _, code in ipairs({ ... }) do list[code] = true end
end
aux.IsCodeListed = function(c, code)
\tlocal list = mycardCodeList[c]
\tif list and list[code] then return true end
\treturn c:ListsCode(code)
end

aux.EnableChangeCode = function(c, code, location, condition)
\taux.AddCodeList(c, code)
\tlocal loc = c:GetOriginalType() & TYPE_MONSTER ~= 0 and LOCATION_MZONE or LOCATION_SZONE
\tloc = location or loc
\tif condition == nil then condition = function() return true end end
\tlocal e1 = Effect.CreateEffect(c)
\te1:SetType(EFFECT_TYPE_SINGLE)
\te1:SetProperty(EFFECT_FLAG_SINGLE_RANGE)
\te1:SetCode(EFFECT_CHANGE_CODE)
\te1:SetRange(loc)
\te1:SetCondition(condition)
\te1:SetValue(code)
\tc:RegisterEffect(e1)
end

-- { 条件, 文案, 返回值 } 列表 → 选出对应返回值（MyCard 的写法，第一参是玩家）
aux.SelectFromOptions = function(tp, ...)
\tlocal options = { ... }
\tlocal ops, opvals = {}, {}
\tfor i = 1, #options do
\t\tif options[i][1] then
\t\t\ttable.insert(ops, options[i][2])
\t\t\ttable.insert(opvals, options[i][3] or i)
\t\tend
\tend
\tif #ops == 0 then return nil end
\tlocal select = Duel.SelectOption(tp, table.unpack(ops))
\treturn opvals[select + 1]
end

-- 下面三个是纯改名，语义与 EDOPro 的实现一致
aux.AddLinkProcedure = function(c, f, min, max)
\taux.LinkProcedure.AddProcedure(c, f, min, max)
end
aux.AddFusionProcFunRep = function(c, f, cc, insf)
\tFusion.AddProcFunRep(c, f, cc, insf)
end
aux.NonTuner = function(f, a, b, c)
\treturn Synchro.NonTuner(f, a, b, c)
end
`

/**
 * MyCard 公共脚本的兼容层：整份抄进 scripts/ 根目录，用「快照 + 还原」保证不覆盖 EDOPro 的实现。
 *
 * 起因：超先行 / 先行服的脚本大量用 aux.AddXyzProcedure、aux.AddSynchroProcedure、
 * aux.NegateMonsterFilter 这类 MyCard 自己在 procedure.lua / utility.lua 里定义的辅助函数，
 * EDOPro 的公共脚本没有它们（EDOPro 是 Xyz.AddProcedure、Synchro.AddProcedure 那套命名）。
 * 这些脚本以前只能整张跳过 —— 超先行 204 张里因此少了一半。
 *
 * 但不能直接拿 MyCard 的 utility.lua 顶掉 EDOPro 的：它第一行就是 `Auxiliary={}`，
 * 整表清空，官方脚本的 aux.* 全变 nil（实测 20 张官方卡当场注册失败）。
 * 所以拆成四步，顺序写在 src/lib/duel/scripts.ts 的 SUPER_PRE_HELPERS 里：
 *   mycard-snapshot.lua   先记下 EDOPro 定义的全部 Auxiliary 成员
 *   mycard-utility.lua    MyCard 的 utility.lua（会清空并重建整张表）
 *   mycard-restore.lua    把记下的成员逐个还原（同名冲突以 EDOPro 为准）
 *   mycard-procedure.lua  MyCard 的 procedure.lua（补上缺失的召唤手续辅助函数）
 */
const MYCARD_SNAPSHOT_SOURCE = `-- 由 npm run assets:duel 生成，重跑会覆盖，不要手改。
-- 记下 EDOPro 公共脚本（utility.lua / proc_*.lua）定义的全部 Auxiliary 成员，
-- 供 mycard-restore.lua 在 MyCard 的 utility.lua 清空整表之后还原。
compatAuxSnapshot = {}
for key, value in pairs(Auxiliary) do
\tcompatAuxSnapshot[key] = value
end
`

const MYCARD_RESTORE_SOURCE = `-- 由 npm run assets:duel 生成，重跑会覆盖，不要手改。
-- MyCard 的 utility.lua 第一行是 Auxiliary={}，会把 EDOPro 的一整套 aux.* 清掉；
-- 这里把同名成员还原回 EDOPro 的实现（只保留 MyCard 独有的函数），即「只补缺、不覆盖」。
for key, value in pairs(compatAuxSnapshot) do
\tAuxiliary[key] = value
end
aux = Auxiliary
compatAuxSnapshot = nil
`

/** 把 MyCard 的公共脚本 + 快照 / 还原脚本写进 scripts/ 根目录（返回拷了几份） */
function copyMycardHelpers(sourceDir, scriptsDir) {
  const utility = join(sourceDir, 'utility.lua')
  const procedure = join(sourceDir, 'procedure.lua')
  if (!existsSync(utility)) return 0
  let copied = 0
  writeFileSync(join(scriptsDir, 'mycard-utility.lua'), readFileSync(utility))
  copied += 1
  if (existsSync(procedure)) {
    writeFileSync(join(scriptsDir, 'mycard-procedure.lua'), readFileSync(procedure))
    copied += 1
  }
  writeFileSync(join(scriptsDir, 'mycard-snapshot.lua'), MYCARD_SNAPSHOT_SOURCE)
  writeFileSync(join(scriptsDir, 'mycard-restore.lua'), MYCARD_RESTORE_SOURCE)
  return copied
}
/**
 * 第三卡库源：站点卡库用的就是它（ygocdb）。
 * BabelCDB + MyCard cdb 合起来会缺一小撮只有客户端才认识的卡号
 * （典型是 100272xxx 的动画卡：方界 / 海晶少女 / 鬼计），
 * 这些卡站内能搜到、能组进卡组，但内核没数据时开局会被整局拒绝。
 */
const YGOCDB_URL = 'https://ygocdb.com/api/v0/cards.zip'

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

/**
 * 下载到缓存目录。
 *
 * 上游（CardScripts / MyCard 脚本 / 卡库）每天都在更新，缓存复用会让人以为
 * "重跑过了"其实还是旧脚本 —— 新卡没脚本时最容易踩这个坑，所以给了 `--refresh`
 * 强制重新拉（npm run assets:duel -- --refresh）。
 */
async function download(url, file) {
  if (!REFRESH && existsSync(file) && statSync(file).size > 1024) {
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
 * type / level / def 的位打包差异统一在这里处理：
 * 灵摆把左右刻度塞进 level 的高两个字节，连接把箭头掩码塞进 def。
 */
function packStats(type, rawLevel, rawDef) {
  let level = rawLevel | 0
  let defense = rawDef | 0
  let lscale = 0
  let rscale = 0
  let linkMarker = 0
  if (type & TYPE_PENDULUM) {
    lscale = (level >>> 24) & 0xff
    rscale = (level >>> 16) & 0xff
    level &= 0xff
  } else if (type & TYPE_LINK) {
    linkMarker = defense & 0xff
    defense = 0
    level &= 0xff
  } else {
    level &= 0xff
  }
  return { level, defense, lscale, rscale, linkMarker }
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
    const stats = packStats(type, row.level, row.def)
    cards.set(row.id, [
      row.alias | 0,
      type,
      stats.level,
      row.attribute | 0,
      row.race | 0,
      row.atk | 0,
      stats.defense,
      stats.lscale,
      stats.rscale,
      stats.linkMarker,
      0,
      row.sc0 | 0,
      row.sc1 | 0,
      row.sc2 | 0,
      row.sc3 | 0,
    ])
  }
  return cards
}

/**
 * 读 ygocdb 的 cards.zip（站点卡库同源），只取内核需要的那些位掩码字段。
 *
 * 这份数据的 type / level / atk / def / race / attribute 和 cdb 完全对得上
 * （实测 1.4 万张里差异全落在 setcode 上），所以拿它补「主库没有的卡号」是安全的；
 * 反过来说，也不能用它整体替换 cards.json —— setcode 的取值口径和 cdb 不一样。
 */
function readYgocdb(zipPath) {
  const files = unzipSync(readFileSync(zipPath))
  const jsonName = Object.keys(files).find((name) => name.endsWith('cards.json'))
  if (!jsonName) throw new Error('ygocdb 卡库结构异常')
  const raw = JSON.parse(new TextDecoder().decode(files[jsonName]))
  const cards = new Map()
  for (const item of Object.values(raw)) {
    const id = item?.id
    const data = item?.data
    if (!id || !data || typeof data.type !== 'number') continue
    const type = data.type | 0
    const stats = packStats(type, data.level, data.def)
    // name 只有人看得懂，内核不需要；alias 无从得知（这些卡本来就没脚本），按 0 处理
    const setcode = BigInt(data.setcode ?? 0)
    cards.set(id, [
      0,
      type,
      stats.level,
      data.attribute | 0,
      data.race | 0,
      data.atk | 0,
      stats.defense,
      stats.lscale,
      stats.rscale,
      stats.linkMarker,
      0,
      Number(setcode & 0xffffn),
      Number((setcode >> 16n) & 0xffffn),
      Number((setcode >> 32n) & 0xffffn),
      Number((setcode >> 48n) & 0xffffn),
    ])
  }
  return cards
}

/**
 * 主卡库优先，补充卡库只补缺失的卡号，ygocdb 再补最后一道，
 * 最后是超先行服的 test-release.cdb（临时编号 1013xxxxx 这些正式库没有的卡）。
 */
function mergeCards(basePath, supplementPath, ygocdbPath, superPrePath) {
  const merged = readCdb(basePath)
  const baseCount = merged.size
  let extra = 0
  for (const [code, data] of readCdb(supplementPath)) {
    if (merged.has(code)) continue
    merged.set(code, data)
    extra += 1
  }
  let ygoExtra = 0
  if (ygocdbPath && existsSync(ygocdbPath)) {
    for (const [code, data] of readYgocdb(ygocdbPath)) {
      if (merged.has(code)) continue
      merged.set(code, data)
      ygoExtra += 1
    }
  }
  let superExtra = 0
  if (superPrePath && existsSync(superPrePath)) {
    for (const [code, data] of readCdb(superPrePath)) {
      if (merged.has(code)) continue
      merged.set(code, data)
      superExtra += 1
    }
  }
  log(
    `· 主卡库 ${baseCount} 张，MyCard 补充 ${extra} 张，ygocdb 补充 ${ygoExtra} 张，` +
      `超先行补充 ${superExtra} 张`,
  )
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

/** 卡片脚本文件名 → 卡号（c12345678.lua） */
function scriptCode(name) {
  const hit = /^c(\d+)\.lua$/.exec(name)
  return hit ? Number(hit[1]) : null
}

/** 公共脚本里定义过的 aux / Auxiliary 函数名（只认定义，不认调用） */
function collectAuxNames(dir) {
  const names = new Set()
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.lua'))) {
    const text = readFileSync(join(dir, file), 'utf8')
    for (const hit of text.matchAll(/function\s+(?:aux|Auxiliary)\.(\w+)\s*\(/g)) names.add(hit[1])
    for (const hit of text.matchAll(/(?:^|\n)\s*(?:aux|Auxiliary)\.(\w+)\s*=/g)) names.add(hit[1])
  }
  return names
}

/** 已经在 scripts/ 各个子目录里的卡片脚本卡号，用来算「上游还没收录的」 */
function collectScriptCodes(scriptsDir, skip = new Set()) {
  const codes = new Set()
  for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || skip.has(entry.name)) continue
    for (const name of readdirSync(join(scriptsDir, entry.name))) {
      const code = scriptCode(name)
      if (code !== null) codes.add(code)
    }
  }
  return codes
}

/**
 * 去掉 Lua 注释与字符串字面量再扫符号。
 *
 * 卡名注释里常带着英文单词（`--罰ゲーム「GREED－欲望の幻像－」`、`--アルカナフォースⅧ－STRENGTH`），
 * 直接拿原文扫会把它们当成缺失常量，白扔能用的脚本。
 */
function stripLuaNoise(text) {
  return text
    .replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\[(=*)\[[\s\S]*?\]\1\]/g, ' ')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
}

/** 脚本里引用了、但公共脚本没有定义的 aux 函数（引用了就会在初始化时报错） */
function missingAuxFunctions(text, auxNames) {
  return [...new Set([...stripLuaNoise(text).matchAll(/aux\.(\w+)/g)].map((hit) => hit[1]))].filter(
    (fn) => !auxNames.has(fn),
  )
}

/** 公共脚本（constant.lua 等）里定义过的全大写常量 */
function collectConstNames(dir) {
  const names = new Set()
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.lua'))) {
    const text = stripLuaNoise(readFileSync(join(dir, file), 'utf8'))
    for (const hit of text.matchAll(/(?:^|\n)\s*([A-Z][A-Z0-9_]+)\s*=/g)) names.add(hit[1])
  }
  return names
}

/**
 * 脚本用到、但公共脚本和脚本自己都没定义的大写常量。
 * 少一个常量就够让 SetCategory / SetCode 在注册阶段报 nil，整张卡都上不了场，
 * 所以导入前必须筛（常量定义在自己文件里的不算缺）。
 */
function missingConstants(text, constNames) {
  const clean = stripLuaNoise(text)
  // 排除 `aux.FALSE` / `obj.FIELD` 这类「表成员」写法：它们不是常量，缺了也只会是 aux 缺函数
  const used = new Set(
    [...clean.matchAll(/(?<![\w.:])([A-Z][A-Z0-9_]{3,})\b/g)].map((hit) => hit[1]),
  )
  const own = new Set(
    [...clean.matchAll(/(?:^|\n)\s*(?:local\s+)?([A-Z][A-Z0-9_]+)\s*=/g)].map((hit) => hit[1]),
  )
  return [...used].filter((name) => !constNames.has(name) && !own.has(name))
}

/**
 * 把 MyCard 先行服脚本里「CardScripts 没有、且不依赖 MyCard 私有辅助函数」的抄进
 * scripts/mycard/，由 ScriptStore 在 official / pre-release 之后兜底。
 *
 * 不能整包抄：MyCard 的脚本会调 aux.bfgcost / aux.SelectFromOptions / aux.AddXyzProcedure
 * 这类它自己公共脚本里的函数，而内核这边配的是 EDOPro 的公共脚本。抄进来会在初始化时
 * 报「attempt to call a nil value」，整张卡注册不上 —— 比没有脚本还糟（没有脚本会走
 * 空脚本兜底，卡至少能上场）。所以按 aux 引用逐个筛。
 */
function copyMycardScripts(sourceDir, scriptsDir) {
  if (!existsSync(sourceDir)) return 0
  // 先清掉上一轮的产物，否则 collectScriptCodes 会把自己抄进来的脚本当成「CardScripts 已有」
  const target = join(scriptsDir, 'mycard')
  rmSync(target, { recursive: true, force: true })
  const known = collectScriptCodes(scriptsDir)
  const auxNames = collectAuxNames(scriptsDir)
  mkdirSync(target, { recursive: true })

  let copied = 0
  let skipped = 0
  for (const name of readdirSync(sourceDir)) {
    const code = scriptCode(name)
    if (code === null || known.has(code)) continue
    const text = readFileSync(join(sourceDir, name), 'utf8')
    const missing = missingAuxFunctions(text, auxNames)
    if (missing.length) {
      skipped += 1
      continue
    }
    writeFileSync(join(target, name), text)
    copied += 1
  }
  log(`· 先行服脚本 ${copied} 个（另有 ${skipped} 个依赖 MyCard 私有辅助函数，跳过）`)
  return copied
}

/** 递归收集目录下的 c<卡号>.lua（EDOPro 安装目录 / 外部脚本包结构不统一，直接全扫） */
function collectCardScriptFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectCardScriptFiles(full, out)
    else if (scriptCode(entry.name) !== null) out.push(full)
  }
  return out
}

/** 卡片脚本文件名（兼容 Windows 分隔符） */
function baseName(file) {
  return file.split(/[\\/]/).pop() ?? file
}

/**
 * 解开外部脚本包：tar.gz 交给 tar，zip 用 fflate（YGOMobile / MC 的先行卡补丁都是 zip）。
 * 只落卡片脚本，卡图 / pack / exe 之类一律不要 —— 这里只负责补脚本。
 */
function unpackScripts(archive, dir) {
  const buf = readFileSync(archive)
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const files = unzipSync(new Uint8Array(buf))
    const root = resolve(dir)
    let count = 0
    for (const [name, data] of Object.entries(files)) {
      if (scriptCode(name.split(/[\\/]/).pop() ?? '') === null) continue
      const dest = join(dir, name)
      // 防止压缩包里的 ../ 写到目录外
      if (!resolve(dest).startsWith(root)) continue
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, data)
      count += 1
    }
    log(`  解出 ${count} 个卡片脚本（zip）`)
    return
  }
  extract(archive, dir)
}

/**
 * 从「上游之外」的来源补齐脚本，写进 scripts/local/（ScriptStore 优先读这一层，
 * assets:duel 不会删它）。
 *
 * 用途：本地装了 EDOPro 整合包（带先行卡脚本），或者从社区仓库拿到了脚本包，
 * 想让这些「CardScripts 还没收录」的卡直接能打，不用一个个手抄。
 *
 * 规则：
 *   - 上游（official / pre-release / mycard / …）已有的卡号跳过，不抢上游的版本；
 *   - local/ 里已经存在的文件不覆盖（那是用户自己放的，可能就是手改过的）；
 *   - 仍然按 aux 引用筛一遍：来源里要是 MyCard 那套私有辅助函数，抄进来会让整张卡注册失败。
 */
function importLocalScripts(sources, scriptsDir) {
  if (!sources.length) return 0
  const target = join(scriptsDir, 'local')
  mkdirSync(target, { recursive: true })
  const known = collectScriptCodes(scriptsDir, new Set(['local']))
  const auxNames = collectAuxNames(scriptsDir)
  const constNames = collectConstNames(scriptsDir)

  let imported = 0
  let skipped = 0
  for (const source of sources) {
    for (const file of collectCardScriptFiles(source.dir)) {
      const code = scriptCode(baseName(file))
      if (code === null || known.has(code)) continue
      const dest = join(target, `c${code}.lua`)
      if (existsSync(dest)) continue
      const text = readFileSync(file, 'utf8')
      if (missingAuxFunctions(text, auxNames).length || missingConstants(text, constNames).length) {
        skipped += 1
        continue
      }
      writeFileSync(dest, text)
      known.add(code)
      imported += 1
    }
  }
  const labels = sources.map((source) => source.label).join('、')
  log(`· 外部来源补充 ${imported} 个脚本（${labels}；跳过 ${skipped} 个不兼容的）`)
  return imported
}

async function fetchText(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}：${url}`)
  return res.text()
}

/** 网络抖动时重试几次（超先行那个 CDN 偶尔 ECONNRESET） */
async function retry(fn, times = 3) {
  let last
  for (let index = 0; index < times; index += 1) {
    try {
      return await fn()
    } catch (error) {
      last = error
      await new Promise((resolve) => setTimeout(resolve, 400 * (index + 1)))
    }
  }
  throw last
}

/** 单次 range 请求最多拉这么大：再大超先行那个 CDN 容易直接把连接掐掉 */
const RANGE_CHUNK_MAX = 192 * 1024

/**
 * 批量按区间取字节：把相邻区间（间隔 ≤ 2KB）合并成一次请求，并发几路。
 * 超先行补丁对整包下载限速严重（几十 KB/s），但小 range 很快，所以宁可多发几次。
 * 返回一个 slice(start, end) 用来从已下载的块里切出任意子区间。
 */
async function readRanges(read, ranges, concurrency = 6, onProgress) {
  const groups = []
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = groups[groups.length - 1]
    const mergeable =
      last && range.start - last.end <= 2 * 1024 && range.end - last.start <= RANGE_CHUNK_MAX
    if (mergeable) last.end = Math.max(last.end, range.end)
    else groups.push({ start: range.start, end: range.end })
  }

  // 单个条目自己就可能超过上限（超先行卡图一张近 300KB），必须再切：
  // CDN 对超大 range 会直接掐连接，而掐在传输中的连接不一定抛错 —— fetch 会一直挂着。
  const chunks = []
  for (const group of groups) {
    for (let start = group.start; start <= group.end; start += RANGE_CHUNK_MAX) {
      chunks.push({ start, end: Math.min(start + RANGE_CHUNK_MAX - 1, group.end) })
    }
  }

  const buffers = new Map()
  let cursor = 0
  let done = 0
  const worker = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= chunks.length) return
      const chunk = chunks[index]
      buffers.set(chunk.start, await read(chunk.start, chunk.end))
      done += 1
      onProgress?.(done, chunks.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker))

  // 目标区间可能横跨两个 chunk（正好压在切分点上），逐个拼起来
  return (start, end) => {
    const parts = []
    let from = start
    while (from <= end) {
      const chunk = chunks.find((item) => from >= item.start && from <= item.end)
      if (!chunk) throw new Error(`区间 ${start}-${end} 没有被批量请求覆盖`)
      const stop = Math.min(end, chunk.end)
      parts.push(buffers.get(chunk.start).subarray(from - chunk.start, stop - chunk.start + 1))
      from = stop + 1
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts)
  }
}

/**
 * 随机读远程 zip 里的指定文件：只取末尾的中央目录 + 目标条目的字节。
 * 超先行补丁有 40MB（卡图 + 卡组 + 近千个脚本），全下太浪费，而我们只要那几十个
 * c<临时编号>.lua。服务端支持 Range（content-range 能拿到总长度）。
 */
async function openRemoteZip(url) {
  const probe = await fetch(url, { headers: { Range: 'bytes=0-0' } })
  const total = Number(/bytes 0-0\/(\d+)/.exec(probe.headers.get('content-range') ?? '')?.[1] ?? 0)
  if (!total) throw new Error(`不支持 Range 请求：${url}`)
  const read = (start, end) =>
    retry(async () => {
      // CDN 有时发到一半就不动了：fetch 本身没有超时，不加 AbortSignal 会一直挂着
      // （表现就是"卡住不动"，Ctrl+C 才能出来）。超时后交给 retry 重来。
      const size = end - start + 1
      const timeout = 20_000 + Math.ceil(size / (64 * 1024)) * 10_000
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: AbortSignal.timeout(timeout),
      })
      if (!res.ok && res.status !== 206) throw new Error(`range ${start}-${end} -> ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    }, 4)

  const tailLen = Math.min(total, 66 * 1024)
  const tail = await read(total - tailLen, total - 1)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error(`zip 结构异常（找不到 EOCD）：${url}`)
  const cdSize = tail.readUInt32LE(eocd + 12)
  const cdOffset = tail.readUInt32LE(eocd + 16)
  const cd = await read(cdOffset, cdOffset + cdSize - 1)

  const entries = new Map()
  let p = 0
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    const name = cd.slice(p + 46, p + 46 + nameLen).toString('utf8')
    entries.set(name, {
      method: cd.readUInt16LE(p + 10),
      compSize: cd.readUInt32LE(p + 20),
      localOffset: cd.readUInt32LE(p + 42),
    })
    p += 46 + nameLen + extraLen + commentLen
  }

  const unpack = (entry, raw) => (entry.method === 0 ? raw : inflateRawSync(raw))

  return {
    count: entries.size,
    async read(name) {
      const entry = entries.get(name)
      if (!entry) return null
      const head = await read(entry.localOffset, entry.localOffset + 29)
      const start = entry.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
      return unpack(entry, await read(start, start + entry.compSize - 1))
    },
    /**
     * 批量取：先批量拿各条目的本地头（要它来算数据起点），再批量拿数据段。
     * 脚本在包里是紧挨着放的，区间合并后一批通常只要两三个请求。
     */
    async readMany(names, { concurrency = 6, onProgress } = {}) {
      const wanted = names.filter((name) => entries.has(name))
      const heads = await readRanges(
        read,
        wanted.map((name) => ({ start: entries.get(name).localOffset, end: entries.get(name).localOffset + 29 })),
        concurrency,
      )
      const spans = wanted.map((name) => {
        const entry = entries.get(name)
        const head = heads(entry.localOffset, entry.localOffset + 29)
        const start = entry.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
        return { name, entry, start, end: start + entry.compSize - 1 }
      })
      const bodies = await readRanges(
        read,
        spans.map((span) => ({ start: span.start, end: span.end })),
        concurrency,
        onProgress,
      )
      const out = new Map()
      for (const span of spans) out.set(span.name, unpack(span.entry, bodies(span.start, span.end)))
      return out
    },
  }
}

/**
 * 批量读远程 zip 条目，失败就拆成小批再来。
 *
 * 超先行那个 CDN 偶尔对某些区间连不上（重试几次也不行），整批一起读会把整个脚本卡死；
 * 拆小之后坏掉的只是那几张，其余照常导入（卡图缺了界面显示占位图，不影响对战）。
 */
async function readManyResilient(zip, names, options = {}) {
  try {
    return await zip.readMany(names, options)
  } catch {
    const batch = 5
    const out = new Map()
    for (let index = 0; index < names.length; index += batch) {
      try {
        for (const [name, data] of await zip.readMany(names.slice(index, index + batch), options)) {
          out.set(name, data)
        }
      } catch {
        /* 这一小批先跳过，下次重跑再补 */
      }
    }
    return out
  }
}

/** 站点卡库里的「中文名 → 正式卡号」，用来把超先行的临时编号对回正式卡 */
function readYgocdbNames(zipPath) {
  const names = new Map()
  if (!existsSync(zipPath)) return names
  const files = unzipSync(readFileSync(zipPath))
  const jsonName = Object.keys(files).find((name) => name.endsWith('cards.json'))
  if (!jsonName) return names
  const raw = JSON.parse(new TextDecoder().decode(files[jsonName]))
  for (const item of Object.values(raw)) {
    const name = String(item?.cn_name || item?.sc_name || '').trim()
    if (item?.id && name) names.set(name, item.id)
  }
  return names
}

/**
 * 从 MC 超先行服补脚本。
 *
 * 超先行服（mycard.world 的 arena 里那个 #/superpre 页面）对还没定正式密码的卡用
 * 1013xxxxx 临时编号，脚本叫 c<临时编号>.lua，卡名是正式的中文名，所以可以：
 *   临时编号 --(同名)→ 站点卡库的正式卡号 → 把脚本改名成 c<正式卡号>.lua 放进 local/
 * 脚本本身通过 GetID() 动态取卡号，不写死编号，改名即可用。
 */
async function importSuperPre(scriptsDir, ygocdbZip, patch) {
  const { list, zip } = patch
  const officialNames = readYgocdbNames(ygocdbZip)

  const target = join(scriptsDir, 'local')
  mkdirSync(target, { recursive: true })
  const known = collectScriptCodes(scriptsDir, new Set(['local']))
  const auxNames = collectAuxNames(scriptsDir)
  const constNames = collectConstNames(scriptsDir)

  // 先算出「卡库里有正式卡号、本地还缺脚本」的那些，再按批去包里取
  const pending = []
  let unmatched = 0
  for (const item of list) {
    const official = officialNames.get(String(item?.name ?? '').trim())
    if (!official) {
      unmatched += 1
      continue
    }
    if (known.has(official)) continue
    pending.push({ official, name: `script/c${item.id}.lua` })
  }

  let imported = 0
  let skipped = 0
  let absent = 0
  /** 被跳过的脚本主要卡在哪些 aux 函数上（方便回头补垫片） */
  const missingStats = new Map()
  for (let index = 0; index < pending.length; index += 20) {
    const chunk = pending.slice(index, index + 20)
    let loaded
    try {
      loaded = await zip.readMany(chunk.map((item) => item.name))
    } catch {
      // 批量失败就拆成小批再试，还不行就留给下次重跑（单批失败不影响其它批）
      loaded = new Map()
      for (let sub = 0; sub < chunk.length; sub += 5) {
        const slice = chunk.slice(sub, sub + 5)
        try {
          for (const [name, data] of await zip.readMany(slice.map((item) => item.name))) {
            loaded.set(name, data)
          }
        } catch {
          /* 这几张下次再说 */
        }
      }
    }
    for (const item of chunk) {
      const buf = loaded.get(item.name)
      if (!buf) {
        absent += 1
        continue
      }
      const text = buf.toString('utf8')
      const missing = [
        ...missingAuxFunctions(text, auxNames).map((fn) => `aux.${fn}`),
        ...missingConstants(text, constNames),
      ]
      if (missing.length) {
        skipped += 1
        for (const name of missing) missingStats.set(name, (missingStats.get(name) ?? 0) + 1)
        continue
      }
      writeFileSync(join(target, `c${item.official}.lua`), text)
      known.add(item.official)
      imported += 1
    }
  }
  if (missingStats.size) {
    const top = [...missingStats.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([fn, count]) => `${fn}(${count})`)
      .join('、')
    log(`· 被跳过的脚本主要缺这些辅助函数：${top}`)
  }
  log(
    `· 超先行补充 ${imported} 个脚本（${unmatched} 张卡在站内卡库查不到正式卡号，` +
      `${absent} 张包里没有脚本，${skipped} 个不兼容）`,
  )
  return imported
}

/**
 * 拉超先行补丁：三个接口和 mycard.world 的 #/superpre 页面完全一样
 * （latest-tag.txt 里是完整下载地址，test-release-v2.json 是卡表）。
 */
async function loadSuperPrePatch() {
  log('… 读超先行服清单')
  const tagUrl = (await fetchText(`${SUPER_PRE_BASE}/data/latest-tag.txt`)).trim()
  const list = JSON.parse(await fetchText(`${SUPER_PRE_BASE}/data/test-release-v2.json`))
  const zip = await openRemoteZip(tagUrl)
  log(`· 超先行补丁 ${tagUrl.split('/').pop()}（${zip.count} 个条目），卡表 ${list.length} 张`)
  return { tagUrl, list: Array.isArray(list) ? list : [], zip }
}

/** cdb 的 texts 表：卡号 → 中文卡名 / 效果文本 */
function readCdbTexts(cdbPath) {
  let DatabaseSync
  try {
    ;({ DatabaseSync } = require('node:sqlite'))
  } catch {
    log('· 跳过超先行卡名：需要 Node 22+ 的 node:sqlite')
    return new Map()
  }
  const db = new DatabaseSync(cdbPath, { readOnly: true })
  const rows = db.prepare('SELECT id, name, desc FROM texts').all()
  db.close()
  const map = new Map()
  for (const row of rows) {
    map.set(row.id, { name: String(row.name || '').trim(), desc: String(row.desc || '') })
  }
  return map
}

/**
 * 卡表里的 `overallString`（`[怪兽|效果] 龙/暗  [★7] 2000/3000`）转成 ygocdb 卡库的
 * `types` 两行格式，好让前端的 normalizeCard 直接解析（种族 / 属性 / 等级 / 攻守 / 箭头 / 刻度）。
 * 魔法 / 陷阱只有一段（`[陷阱|永续]`），保持单行。
 */
function overallToTypeLine(overall) {
  const raw = String(overall || '')
    .replace(/☆/g, '★')
    .replace(/\s+/g, ' ')
    .trim()
  if (!raw) return ''
  // 等级标记出现的位置就是两行的分界；魔法 / 陷阱没有这一段，保持单行
  const at = raw.search(/\[(★|LINK|RANK)-?\d+\]/i)
  if (at <= 0) return raw
  return `${raw.slice(0, at).trim()}\n${raw.slice(at).trim()}`
}

/**
 * 把「还没有正式密码」的超先行卡按临时编号整批接进来。
 *
 * importSuperPre 走的是「临时编号 →(同名)→ 正式卡号」，只覆盖正式服卡库已经承认的卡；
 * 刚公布、还没定密码的新卡在卡库里查不到，只能沿用超先行服的临时编号（1013xxxxx 等）。
 * 这里把它们落成三样东西：
 *   scripts/superpre/c<临时编号>.lua       卡片脚本（依赖不兼容的跳过）
 *   duel-assets/pics/superpre/<临时编号>.jpg 卡图（同源，长图 / GIF 能画进 canvas）
 *   duel-assets/superpre-cards.json        前端卡库条目（ygocdb 同格式，交给 normalizeCard）
 * 内核卡数据由 mergeCards 从 test-release.cdb 合并进 cards.json。
 */
async function importSuperPreCatalog(scriptsDir, patch, ygocdbZip) {
  const { list, zip } = patch
  const target = join(scriptsDir, 'superpre')
  const picDir = join(OUT, 'pics', 'superpre')
  // 脚本是生成物，每次重建；手工补丁放 local/（那边不删）。
  // 卡图不删：一张 300KB、CDN 又慢，重跑时按「缺哪张补哪张」处理（--refresh 才重下）。
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  mkdirSync(picDir, { recursive: true })

  const cdb = (await zip.readMany(['test-release.cdb'])).get('test-release.cdb')
  if (!cdb) {
    log('· 超先行补丁里没有 test-release.cdb，跳过临时编号卡')
    writeFileSync(join(OUT, 'superpre-cards.json'), JSON.stringify({ version: 1, cards: [] }))
    return 0
  }
  const cdbPath = join(CACHE, 'superpre.cdb')
  writeFileSync(cdbPath, cdb)
  const texts = readCdbTexts(cdbPath)
  const dataCodes = new Set(readCdb(cdbPath).keys())

  const officialNames = readYgocdbNames(ygocdbZip)
  const auxNames = collectAuxNames(scriptsDir)
  const constNames = collectConstNames(scriptsDir)

  // 有正式卡号的走 importSuperPre 的改名路线，两边都导会让同一张卡在卡库里出现两次
  const pending = []
  let withOfficial = 0
  for (const item of list) {
    const id = Number(item?.id)
    if (!id || !dataCodes.has(id) || !texts.has(id)) continue
    const name = String(item?.name || texts.get(id)?.name || '').trim()
    if (name && officialNames.has(name)) {
      withOfficial += 1
      continue
    }
    pending.push({ id, name, overall: item?.overallString })
  }

  log(`· 取 ${pending.length} 个临时编号卡的脚本…`)
  const scripts = pending.length
    ? await readManyResilient(zip, pending.map((item) => `script/c${item.id}.lua`))
    : new Map()
  const accepted = []
  const missingStats = new Map()
  let noScript = 0
  let skipped = 0
  for (const item of pending) {
    const buf = scripts.get(`script/c${item.id}.lua`)
    if (!buf) {
      noScript += 1
      continue
    }
    const scriptText = buf.toString('utf8')
    const missing = [
      ...missingAuxFunctions(scriptText, auxNames).map((fn) => `aux.${fn}`),
      ...missingConstants(scriptText, constNames),
    ]
    if (missing.length) {
      skipped += 1
      for (const name of missing) missingStats.set(name, (missingStats.get(name) ?? 0) + 1)
      continue
    }
    accepted.push({ ...item, scriptText })
  }

  // 卡图一张近 300KB，是整段导入里最慢的一步：超先行 CDN 限速严重，18MB 能走好几分钟，
  // 所以已经下过的跳过（--refresh 才重下），并且分段报进度，不然看起来像是卡死了。
  const needPics = accepted.filter((item) => REFRESH || !existsSync(join(picDir, `${item.id}.jpg`)))
  let pics = new Map()
  if (needPics.length) {
    const mb = Math.round((needPics.length * 300) / 1024)
    log(`· 取 ${needPics.length} 张超先行卡图（约 ${mb}MB，CDN 慢，可能要几分钟；已下载的会跳过）…`)
    let reported = 0
    pics = await readManyResilient(
      zip,
      needPics.map((item) => `pics/${item.id}.jpg`),
      {
        concurrency: 8,
        onProgress: (done, total) => {
          const step = Math.max(10, Math.floor(total / 10))
          if (done === total || done - reported >= step) {
            reported = done
            log(`  · 卡图 ${done}/${total}`)
          }
        },
      },
    )
  }
  const catalog = []
  let picCount = 0
  for (const item of accepted) {
    writeFileSync(join(target, `c${item.id}.lua`), item.scriptText)
    const pic = pics.get(`pics/${item.id}.jpg`)
    if (pic) {
      writeFileSync(join(picDir, `${item.id}.jpg`), pic)
      picCount += 1
    } else if (existsSync(join(picDir, `${item.id}.jpg`))) {
      picCount += 1
    }
    const text = texts.get(item.id)
    catalog.push({
      id: item.id,
      cn_name: item.name || text?.name || `未知卡片 ${item.id}`,
      text: {
        types: overallToTypeLine(item.overall),
        desc: String(text?.desc || '').replace(/\r/g, ''),
      },
      data: { ot: 1 },
    })
  }
  writeFileSync(
    join(OUT, 'superpre-cards.json'),
    JSON.stringify({ version: 1, cards: catalog.sort((a, b) => a.id - b.id) }),
  )

  if (missingStats.size) {
    const top = [...missingStats.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([fn, count]) => `${fn}(${count})`)
      .join('、')
    log(`· 超先行临时编号卡被跳过的脚本主要缺这些辅助函数：${top}`)
  }
  log(
    `· 超先行临时编号卡导入 ${accepted.length} 张（卡图 ${picCount} 张；${withOfficial} 张有正式卡号走另一边，` +
      `${noScript} 张包里没脚本，${skipped} 张依赖不兼容）`,
  )
  return accepted.length
}

async function main() {
  if (REFRESH) log('· --refresh：忽略 .cache，重新下载上游并覆盖解压')
  mkdirSync(CACHE, { recursive: true })
  mkdirSync(OUT, { recursive: true })

  const scriptsTar = join(CACHE, 'card-scripts.tar.gz')
  const dbTar = join(CACHE, 'babel-cdb.tar.gz')
  const supplementTar = join(CACHE, 'mycard-cdb.tar.gz')
  const mycardScriptsTar = join(CACHE, 'mycard-scripts.tar.gz')
  const ygocdbZip = join(CACHE, 'ygocdb-cards.zip')
  await download(SCRIPTS_URL, scriptsTar)
  await download(DATABASE_URL, dbTar)
  await download(SUPPLEMENT_URL, supplementTar)
  await download(MYCARD_SCRIPTS_URL, mycardScriptsTar)
  await download(YGOCDB_URL, ygocdbZip)

  // 脚本：tar 里的顶层目录名不固定，直接去掉第一层。
  // 解压是覆盖式的：--refresh 时直接重解压，不会删掉手工补丁目录 local/（也不做整目录删除，
  // 上万文件的批量删除容易被 IDE / 系统的删除保护拦下来）。
  const scriptsDir = join(OUT, 'scripts')
  if (REFRESH || !existsSync(join(scriptsDir, 'constant.lua'))) {
    log('… 解压卡片脚本')
    extract(scriptsTar, scriptsDir, ['--strip-components=1'])
  }
  const cardScriptCount = existsSync(join(scriptsDir, 'official'))
    ? readdirSync(join(scriptsDir, 'official')).filter((name) => name.endsWith('.lua')).length
    : 0

  // 先行服脚本（MyCard 独有 + 不依赖它私有辅助函数的那些）
  const mycardSource = join(CACHE, 'mycard-scripts')
  if (REFRESH || !existsSync(mycardSource)) {
    log('… 解压先行服脚本')
    extract(mycardScriptsTar, mycardSource, ['--strip-components=1'])
  }
  // 兼容层要在筛选之前就位：后面的「依赖检查」看的是 scripts/ 根目录里实际存在的 aux 定义
  const mycardHelperCount = copyMycardHelpers(mycardSource, scriptsDir)
  if (mycardHelperCount) {
    log(`· 兼容层 ${mycardHelperCount} 个（MyCard 的 utility / procedure + 快照还原）`)
  }
  log('… 筛选先行服脚本')
  const mycardScriptCount = copyMycardScripts(mycardSource, scriptsDir)
  // 兼容垫片：补齐 MyCard / 超先行脚本用到、EDOPro 公共脚本没有的常量与 GetID 语义。
  // 无条件写入：它只补缺、不覆盖可用实现（GetID 多返回一个值、补几个常量、还原两个废弃函数），
  // 对官方脚本没有影响；而 --superpre / 外部导入的脚本可能都用得上。
  const compatPath = join(scriptsDir, MYCARD_COMPAT)
  writeFileSync(compatPath, MYCARD_COMPAT_SOURCE)

  // 外部脚本来源（可选）：本地目录（EDOPro 安装目录 / 先行卡补丁解压目录）/ 任意脚本包
  const localSources = []
  for (const dir of EDOPRO_DIRS) {
    const full = resolve(dir)
    if (!existsSync(full)) {
      log(`· 跳过 --edopro=${dir}：目录不存在`)
      continue
    }
    localSources.push({ label: dir, dir: full })
  }
  for (const [index, url] of EXTRA_SCRIPT_URLS.entries()) {
    const archive = join(CACHE, `extra-scripts-${index}.archive`)
    const dir = join(CACHE, `extra-scripts-${index}`)
    await download(url, archive)
    if (REFRESH || !existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
      unpackScripts(archive, dir)
    }
    localSources.push({ label: url, dir })
  }
  if (localSources.length) importLocalScripts(localSources, scriptsDir)
  let superPreScriptCount = 0
  const superPreCdb = join(CACHE, 'superpre.cdb')
  if (USE_SUPER_PRE) {
    const patch = await loadSuperPrePatch()
    // 先按正式卡号导入（卡库已承认的卡），再按临时编号导入（还没有正式密码的新卡）
    await importSuperPre(scriptsDir, ygocdbZip, patch)
    superPreScriptCount = await importSuperPreCatalog(scriptsDir, patch, ygocdbZip)
  } else if (existsSync(superPreCdb)) {
    // 没开 --superpre 但上一轮留下过 cdb：卡数据继续用，脚本目录也还在
    log('· 复用上一轮的超先行卡数据（要更新就加 --superpre）')
  }

  // 根目录下的公共脚本（constant / utility / proc_* ……）开局前全部预载
  const helpers = readdirSync(scriptsDir)
    .filter((name) => name.endsWith('.lua'))
    .sort()
  writeFileSync(join(scriptsDir, 'helpers.json'), JSON.stringify(helpers))
  log(`· 公共脚本 ${helpers.length} 个，卡片脚本 ${cardScriptCount} 个`)

  // 卡库（主 + 补充）
  const cdbRel = 'BabelCDB-master/cards.cdb'
  const cdbPath = join(CACHE, cdbRel)
  if (REFRESH || !existsSync(cdbPath)) {
    log('… 解压卡库')
    extract(dbTar, CACHE, [cdbRel])
  }
  const supplementPath = join(CACHE, SUPPLEMENT_REL)
  if (REFRESH || !existsSync(supplementPath)) {
    log('… 解压补充卡库')
    extract(supplementTar, CACHE, [SUPPLEMENT_REL])
  }

  // 提示文本：内核 MSG_HINT 里给的是 "/system" 字符串 id，靠 strings.conf 翻译
  const stringsRel = 'ygopro-database-master/locales/zh-CN/strings.conf'
  const stringsPath = join(CACHE, stringsRel)
  if (REFRESH || !existsSync(stringsPath)) {
    log('… 解压 strings.conf')
    extract(supplementTar, CACHE, [stringsRel])
  }
  log('… 生成 strings.json')
  const system = parseStrings(stringsPath)
  writeFileSync(join(OUT, 'strings.json'), JSON.stringify({ system }))
  log(`· 提示文本 ${Object.keys(system).length} 条`)

  log('… 生成 cards.json')
  const cards = mergeCards(cdbPath, supplementPath, ygocdbZip, superPreCdb)
  const json = JSON.stringify({ version: 1, cards })
  writeFileSync(join(OUT, 'cards.json'), json)
  log(`· 卡数据 ${Object.keys(cards).length} 张，${humanSize(Buffer.byteLength(json))}`)

  log('… 生成 descriptions.json')
  const descriptions = readDescriptions([supplementPath, cdbPath, superPreCdb])
  const descriptionJson = JSON.stringify({ descriptions })
  writeFileSync(join(OUT, 'descriptions.json'), descriptionJson)
  log(`· 效果分条 ${Object.keys(descriptions).length} 张，${humanSize(Buffer.byteLength(descriptionJson))}`)

  writeFileSync(
    join(OUT, 'manifest.json'),
    JSON.stringify(
      {
        helpers: helpers.length,
        cardScripts: cardScriptCount,
        mycardScripts: mycardScriptCount,
        superPreScripts: superPreScriptCount,
        cards: Object.keys(cards).length,
        builtAt: Date.now(),
      },
      null,
      2,
    ),
  )
  log(`\n完成：${OUT}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
