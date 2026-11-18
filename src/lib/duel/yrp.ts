import type { DuelDeck } from './types'

/**
 * .yrp 录像写入。
 *
 * 格式来自 ygopro 客户端 `gframe/replay.{h,cpp}`：
 *
 *   ExtendedReplayHeader (80B)
 *   ├ ReplayHeader: id / version / flag / seed / datasize / start_time / props[8]  (32B)
 *   ├ seed_sequence[8] (SEED_COUNT = 8，8 × u32)                                  (32B)
 *   └ header_version / value1..3                                                  (16B)
 *   数据段（datasize 字节）
 *   ├ 双方名字：各 40B（20 个 UTF-16LE 码元）
 *   ├ 决斗参数：start_lp / start_hand / draw_count / duel_flag（4 × i32）
 *   ├ 卡组：主×2 + 额外×2，每组 i32 张数 + 张数 × 卡号（倒序写入）
 *   └ 响应流：[u8 长度][响应字节] 逐条
 *
 * 这里刻意不压缩（flag 不带 REPLAY_COMPRESSED）：ygopro 读取时按 flag 分叉，
 * 未压缩分支直接读原始数据，省掉 LZMA 依赖。datasize 必须写原始长度。
 */

const REPLAY_ID_YRP2 = 0x32707279
const REPLAY_ID_YRP1 = 0x31707279
/** 客户端版本号；>= 0x1353 时必须带 REPLAY_UNIFORM，否则会被判为非法录像 */
const REPLAY_VERSION = 0x1362
const REPLAY_UNIFORM = 0x10
const SEED_COUNT = 8
const NAME_BYTES = 40
/** 数据段被 LZMA 压缩（ygopro 默认开启），浏览器里解不了 */
const REPLAY_FLAG_COMPRESSED = 0x1

export interface ReplayOptions {
  seed: [bigint, bigint, bigint, bigint]
  playerDeck: DuelDeck
  opponentDeck: DuelDeck
  names: [string, string]
  /** 按顺序记录的全部响应字节 */
  responses: Uint8Array[]
  startingLP: number
  startingHand: number
  drawCount: number
  /** 32 位决斗规则标志（MR5 = 0x2e800） */
  duelFlags: number
}

export function buildReplay(options: ReplayOptions): Uint8Array {
  const info = new ByteWriter()
  writeName(info, options.names[0])
  writeName(info, options.names[1])
  info.i32(options.startingLP)
  info.i32(options.startingHand)
  info.i32(options.drawCount)
  info.i32(options.duelFlags)

  for (const deck of [options.playerDeck, options.opponentDeck]) {
    // 和 ygopro 一致：倒序写入，内核读到的顺序才和客户端展示一致
    writeDeck(info, deck.main)
    writeDeck(info, deck.extra)
  }

  const infoBytes = info.bytes()
  let dataSize = infoBytes.byteLength
  for (const response of options.responses) dataSize += 1 + response.byteLength

  const header = new ByteWriter()
  header.u32(REPLAY_ID_YRP2)
  header.u32(REPLAY_VERSION)
  header.u32(REPLAY_UNIFORM)
  header.u32(Number(options.seed[0] & 0xffffffffn))
  header.u32(dataSize)
  header.u32(Math.floor(Date.now() / 1000))
  header.zeros(8)

  // 4 个 64 位种子拆成 8 个 32 位：低半在前，和内核那边的拼装顺序保持一致
  const seedSequence: number[] = []
  for (const value of options.seed) {
    seedSequence.push(Number(value & 0xffffffffn))
    seedSequence.push(Number((value >> 32n) & 0xffffffffn))
  }
  if (seedSequence.length < SEED_COUNT) seedSequence.push(...Array(SEED_COUNT - seedSequence.length).fill(0))
  for (const part of seedSequence.slice(0, SEED_COUNT)) header.u32(part)

  header.u32(1) // header_version
  header.u32(0)
  header.u32(0)
  header.u32(0)

  const headerBytes = header.bytes()
  const out = new Uint8Array(headerBytes.byteLength + dataSize)
  out.set(headerBytes, 0)
  out.set(infoBytes, headerBytes.byteLength)

  let offset = headerBytes.byteLength + infoBytes.byteLength
  for (const response of options.responses) {
    const length = Math.min(response.byteLength, 0xff)
    out[offset] = length
    offset += 1
    out.set(response.subarray(0, length), offset)
    offset += length
  }
  return out
}

function writeName(writer: ByteWriter, name: string) {
  const buffer = new Uint8Array(NAME_BYTES)
  const chars = [...name].slice(0, NAME_BYTES / 2)
  chars.forEach((char, index) => {
    const code = char.codePointAt(0) ?? 0
    // 只写 BMP 内的码元，代理对直接丢（名字显示不全无所谓，不能挤坏后续字段）
    if (code > 0xffff) return
    buffer[index * 2] = code & 0xff
    buffer[index * 2 + 1] = (code >> 8) & 0xff
  })
  writer.push(buffer)
}

function writeDeck(writer: ByteWriter, codes: number[]) {
  writer.i32(codes.length)
  for (let index = codes.length - 1; index >= 0; index -= 1) writer.i32(codes[index])
}

class ByteWriter {
  private buffer = new Uint8Array(256)
  private view = new DataView(this.buffer.buffer)
  private offset = 0

  private grow(need: number) {
    if (this.offset + need <= this.buffer.byteLength) return
    const next = new Uint8Array(Math.max(this.buffer.byteLength * 2, this.offset + need))
    next.set(this.buffer, 0)
    this.buffer = next
    this.view = new DataView(next.buffer)
  }

  u32(value: number) {
    this.grow(4)
    this.view.setUint32(this.offset, value >>> 0, true)
    this.offset += 4
  }

  i32(value: number) {
    this.grow(4)
    this.view.setInt32(this.offset, value | 0, true)
    this.offset += 4
  }

  zeros(count: number) {
    this.grow(count)
    this.offset += count
  }

  push(data: Uint8Array) {
    this.grow(data.byteLength)
    this.buffer.set(data, this.offset)
    this.offset += data.byteLength
  }

  bytes(): Uint8Array {
    return this.buffer.slice(0, this.offset)
  }
}

export interface ParsedReplay {
  format: 'yrp1' | 'yrp2'
  /** 数据段压缩过（LZMA），浏览器里读不了 */
  compressed: boolean
  /** 4 × 64 位种子；老录像只有 32 位种子时后面补 0 */
  seed: [bigint, bigint, bigint, bigint]
  names: [string, string]
  startingLP: number
  startingHand: number
  drawCount: number
  duelFlags: number
  /** 双方卡组（已是录像里记录的实际顺序，直接喂给内核即可） */
  playerDeck: DuelDeck
  opponentDeck: DuelDeck
  /** 按顺序记录的原始响应字节（含沙包） */
  responses: Uint8Array[]
}

/**
 * 读 .yrp：只支持未压缩数据段。
 *
 * 头部长度各版本不一致（props 有的写 8 字节、有的按 32 字节，还可能带
 * seed_sequence 扩展），所以不按固定偏移切，而是用「文件总长 - datasize」
 * 反推数据段起点，再从数据段尾部往前找 seed_sequence。
 */
export function parseReplay(bytes: Uint8Array): ParsedReplay {
  if (bytes.byteLength < 96) throw new Error('不是有效的 .yrp 文件（体积过小）')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const id = view.getUint32(0, true)
  if (id !== REPLAY_ID_YRP1 && id !== REPLAY_ID_YRP2) {
    throw new Error('不是有效的 .yrp 录像（文件头标识不符）')
  }
  const flag = view.getUint32(8, true)
  const dataSize = view.getUint32(16, true)
  if (!dataSize || dataSize > bytes.byteLength) throw new Error('录像头里的数据长度不合法')

  const compressed = (flag & REPLAY_FLAG_COMPRESSED) !== 0
  if (compressed) {
    throw new Error(
      '这条录像的数据段是压缩的（LZMA），本工具只能解析未压缩的 .yrp。请用「combo 推演」页导出的录像。',
    )
  }

  const dataStart = bytes.byteLength - dataSize
  if (dataStart < 56) throw new Error('录像头长度异常')

  const seed = readSeed(view, dataStart)
  const names: [string, string] = [readName(view, dataStart), readName(view, dataStart + NAME_BYTES)]

  let cursor = dataStart + NAME_BYTES * 2
  const startingLP = view.getInt32(cursor, true)
  const startingHand = view.getInt32(cursor + 4, true)
  const drawCount = view.getInt32(cursor + 8, true)
  const duelFlags = view.getInt32(cursor + 12, true)
  cursor += 16

  const playerMain = readDeck(view, cursor)
  const playerExtra = readDeck(view, playerMain.cursor)
  const opponentMain = readDeck(view, playerExtra.cursor)
  const opponentExtra = readDeck(view, opponentMain.cursor)
  cursor = opponentExtra.cursor

  const responses: Uint8Array[] = []
  while (cursor < bytes.byteLength) {
    const length = bytes[cursor]
    cursor += 1
    if (!length || cursor + length > bytes.byteLength) break
    responses.push(bytes.slice(cursor, cursor + length))
    cursor += length
  }

  return {
    format: id === REPLAY_ID_YRP2 ? 'yrp2' : 'yrp1',
    compressed,
    seed,
    names,
    startingLP: startingLP || 8000,
    startingHand: startingHand || 5,
    drawCount: drawCount || 1,
    duelFlags,
    playerDeck: { main: playerMain.codes, extra: playerExtra.codes },
    opponentDeck: { main: opponentMain.codes, extra: opponentExtra.codes },
    responses,
  }
}

function readSeed(view: DataView, dataStart: number): [bigint, bigint, bigint, bigint] {
  // 扩展头尾部固定是 seed_sequence[8] + header_version + value1..3
  const offset = dataStart - SEED_COUNT * 4 - 16
  if (offset >= 24 && offset + SEED_COUNT * 4 <= dataStart) {
    const parts: number[] = []
    for (let index = 0; index < SEED_COUNT; index += 1) parts.push(view.getUint32(offset + index * 4, true))
    const seed = [0, 1, 2, 3].map(
      (index) => (BigInt(parts[index * 2 + 1]) << 32n) | BigInt(parts[index * 2]),
    ) as [bigint, bigint, bigint, bigint]
    if (seed.some((value) => value !== 0n)) return seed
  }
  // 没有扩展头：只有头部里那 32 位种子
  return [BigInt(view.getUint32(12, true)), 0n, 0n, 0n]
}

function readName(view: DataView, offset: number): string {
  let text = ''
  for (let index = 0; index < NAME_BYTES / 2; index += 1) {
    const code = view.getUint16(offset + index * 2, true)
    if (!code) break
    text += String.fromCharCode(code)
  }
  return text
}

/** 录像里卡组是倒序写入的，读的时候反向填回，得到开局时的真实顺序 */
function readDeck(view: DataView, offset: number): { codes: number[]; cursor: number } {
  let cursor = offset
  const count = view.getInt32(cursor, true)
  cursor += 4
  if (count < 0 || count > 200 || cursor + count * 4 > view.byteLength) {
    throw new Error('录像卡组数据损坏')
  }
  const codes: number[] = new Array(count)
  for (let index = count - 1; index >= 0; index -= 1) {
    codes[index] = view.getInt32(cursor, true)
    cursor += 4
  }
  return { codes, cursor }
}

export function downloadReplay(bytes: Uint8Array, fileName: string) {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
