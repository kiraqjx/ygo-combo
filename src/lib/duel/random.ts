/**
 * 种子驱动的洗牌。
 *
 * ocgcore 自己不会洗牌：客户端加卡时的顺序就是卡组顺序，
 * 所以"随机起手"必须由我们按种子洗好再喂给内核。
 * 好处是同一个种子 + 同一套卡组 = 同一份起手，录像和将来的"指定起手搜索"都靠它。
 */

const MASK64 = (1n << 64n) - 1n

/** splitmix64：把 4 个 64 位种子揉成一个可复现的随机流 */
export function createRng(seeds: [bigint, bigint, bigint, bigint]): () => bigint {
  let state = (seeds[0] ^ (seeds[1] << 13n) ^ (seeds[2] << 29n) ^ (seeds[3] << 47n)) & MASK64
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & MASK64
    let z = state
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64
    return (z ^ (z >> 31n)) & MASK64
  }
}

/** Fisher-Yates，随机源由调用方提供，保证可复现 */
export function shuffleWith<T>(list: T[], next: () => bigint): T[] {
  const out = [...list]
  for (let index = out.length - 1; index > 0; index -= 1) {
    const offset = Number(next() % BigInt(index + 1))
    const swap = out[index]
    out[index] = out[offset]
    out[offset] = swap
  }
  return out
}
