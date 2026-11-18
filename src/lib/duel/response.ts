import { OcgResponseType, type OcgResponse } from 'ocgcore-wasm'
import type { DuelQuestion } from './types'

/** 每类提问只可能收到这几种响应；暂存回放时用它校验队列有没有错位 */
const RESPONSE_TYPES: Record<DuelQuestion['kind'], OcgResponseType[]> = {
  idle: [OcgResponseType.SELECT_IDLECMD],
  battle: [OcgResponseType.SELECT_BATTLECMD],
  chain: [OcgResponseType.SELECT_CHAIN],
  yesno: [OcgResponseType.SELECT_YESNO, OcgResponseType.SELECT_EFFECTYN],
  option: [OcgResponseType.SELECT_OPTION],
  card: [OcgResponseType.SELECT_CARD],
  tribute: [OcgResponseType.SELECT_TRIBUTE],
  sum: [OcgResponseType.SELECT_SUM],
  unselect: [OcgResponseType.SELECT_UNSELECT_CARD],
  place: [OcgResponseType.SELECT_PLACE, OcgResponseType.SELECT_DISFIELD],
  position: [OcgResponseType.SELECT_POSITION],
  sort: [OcgResponseType.SORT_CARD],
  other: [],
}

export function responseMatchesQuestion(response: OcgResponse, question: DuelQuestion): boolean {
  const allowed = RESPONSE_TYPES[question.kind]
  // 宣言类（种族 / 属性 / 卡名 / 数字）的响应形态太多，不做校验
  if (!allowed.length) return true
  return allowed.includes(response.type)
}

/**
 * 把响应对象编码成内核要的字节流。
 *
 * 布局必须和 `ocgcore-wasm` 内部的 createResponse 完全一致（小端、无对齐），
 * 因为这些字节同时要写进 .yrp 录像，回放时会被 set_responseb 直接吃回去。
 */
export function encodeResponse(response: OcgResponse): Uint8Array {
  const writer = new ByteWriter()
  switch (response.type) {
    case OcgResponseType.SELECT_BATTLECMD:
    case OcgResponseType.SELECT_IDLECMD:
      writer.i32(response.action | ((response.index ?? 0) << 16))
      break
    case OcgResponseType.SELECT_EFFECTYN:
    case OcgResponseType.SELECT_YESNO:
      writer.i32(response.yes ? 1 : 0)
      break
    case OcgResponseType.SELECT_OPTION:
      writer.i32(response.index)
      break
    case OcgResponseType.SELECT_CARD:
    case OcgResponseType.SELECT_TRIBUTE:
    case OcgResponseType.SELECT_SUM:
      if (response.indicies && response.indicies.length) {
        writer.i32(0)
        writer.i32(response.indicies.length)
        for (const index of response.indicies) writer.i32(index)
      } else {
        writer.i32(-1)
      }
      break
    case OcgResponseType.SELECT_CARD_CODES:
      if (response.codes && response.codes.length) {
        writer.i32(0)
        writer.i32(response.codes.length)
        for (const code of response.codes) writer.i32(code)
      } else {
        writer.i32(-1)
      }
      break
    case OcgResponseType.SELECT_UNSELECT_CARD:
      if (response.index === null || response.index === undefined) {
        writer.i32(-1)
      } else {
        writer.i32(1)
        writer.i32(response.index)
      }
      break
    case OcgResponseType.SELECT_PLACE:
    case OcgResponseType.SELECT_DISFIELD:
      for (const place of response.places) {
        writer.i8(place.player)
        writer.i8(place.location)
        writer.i8(place.sequence)
      }
      break
    case OcgResponseType.SELECT_CHAIN:
      writer.i32(response.index === null || response.index === undefined ? -1 : response.index)
      break
    case OcgResponseType.SELECT_POSITION:
      writer.i32(response.position)
      break
    case OcgResponseType.SELECT_COUNTER:
      for (const count of response.counters) writer.i16(count)
      break
    case OcgResponseType.SORT_CARD:
      if (!response.order) {
        writer.i8(-1)
        break
      }
      // 内核这里要的是「卡片数 - 1」，写卡片数会被判非法并 RETRY
      writer.i8(response.order.length - 1)
      for (const index of response.order) writer.i8(index)
      break
    case OcgResponseType.ANNOUNCE_RACE: {
      let race = 0n
      for (const item of response.races) race |= item
      writer.u64(race)
      break
    }
    case OcgResponseType.ANNOUNCE_ATTRIB: {
      let attribute = 0
      for (const item of response.attributes) attribute |= item
      writer.u32(attribute)
      break
    }
    case OcgResponseType.ANNOUNCE_CARD:
      writer.i32(response.card)
      break
    case OcgResponseType.ANNOUNCE_NUMBER:
      writer.i32(response.value)
      break
    case OcgResponseType.ROCK_PAPER_SCISSORS:
      writer.i32(response.value)
      break
    default:
      writer.i32(0)
  }
  return writer.bytes()
}

class ByteWriter {
  private buffer = new Uint8Array(64)
  private view = new DataView(this.buffer.buffer)
  private offset = 0

  private grow(need: number) {
    if (this.offset + need <= this.buffer.byteLength) return
    const next = new Uint8Array(Math.max(this.buffer.byteLength * 2, this.offset + need))
    next.set(this.buffer, 0)
    this.buffer = next
    this.view = new DataView(next.buffer)
  }

  i8(value: number) {
    this.grow(1)
    this.view.setInt8(this.offset, value)
    this.offset += 1
  }

  i16(value: number) {
    this.grow(2)
    this.view.setInt16(this.offset, value, true)
    this.offset += 2
  }

  u32(value: number) {
    this.grow(4)
    this.view.setUint32(this.offset, value, true)
    this.offset += 4
  }

  i32(value: number) {
    this.grow(4)
    this.view.setInt32(this.offset, value, true)
    this.offset += 4
  }

  u64(value: bigint) {
    this.grow(8)
    this.view.setBigUint64(this.offset, value, true)
    this.offset += 8
  }

  bytes(): Uint8Array {
    return this.buffer.slice(0, this.offset)
  }
}
