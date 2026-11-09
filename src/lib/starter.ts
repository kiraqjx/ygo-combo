/** C(available, draws) / C(deckSize, draws)：抽 draws 张全部落在 available 张里的概率 */
function handRatio(deckSize: number, available: number, draws: number): number {
  if (deckSize <= 0 || available < draws) return 0
  let ratio = 1
  for (let i = 0; i < draws; i += 1) ratio *= (available - i) / (deckSize - i)
  return ratio
}

/**
 * 抽 draws 张时，copies 列表里每张卡都至少上手 1 张的概率。
 * copies 是该卡在主卡组的张数；任意一张为 0 则整组不可能成立。
 */
export function allPresentChance(deckSize: number, copies: number[], draws: number): number {
  if (deckSize <= 0) return 0
  if (!copies.length) return 1
  if (copies.some((count) => count <= 0)) return 0

  const n = Math.min(Math.max(0, Math.floor(draws)), deckSize)
  if (n <= 0) return 0

  // 容斥：1 - ΣP(缺某张) + ΣP(缺某两张) - …
  const k = copies.length
  let chance = 1
  for (let mask = 1; mask < 1 << k; mask += 1) {
    let missing = 0
    let bits = 0
    for (let i = 0; i < k; i += 1) {
      if (mask & (1 << i)) {
        missing += copies[i]
        bits += 1
      }
    }
    const term = handRatio(deckSize, deckSize - missing, n)
    chance += bits % 2 === 1 ? -term : term
  }
  return Math.min(1, Math.max(0, chance))
}

/** 去掉空组、重复组，以及被其他组包含的组（启动条件更宽松的组已经覆盖它） */
function pruneGroups(groups: number[][]): number[][] {
  const prepared = groups.filter((group) => group.length > 0).map((group) => [...new Set(group)])
  const sets = prepared.map((group) => new Set(group))
  const seen = new Set<string>()
  const out: number[][] = []

  prepared.forEach((group, index) => {
    const key = [...sets[index]].sort((a, b) => a - b).join(',')
    if (seen.has(key)) return
    seen.add(key)

    const redundant = prepared.some((other, otherIndex) => {
      if (otherIndex === index) return false
      const otherSet = sets[otherIndex]
      if (otherSet.size >= sets[index].size) return false
      for (const id of otherSet) if (!sets[index].has(id)) return false
      return true
    })
    if (!redundant) out.push(group)
  })

  return out
}

/**
 * 多组启动卡的「或」概率：任意一组全部上手即算启动成功。
 *
 * @param groups  每组要同时上手的卡号
 * @param copiesOf 卡号 → 主卡组张数
 */
export function atLeastOneStarterChance(
  deckSize: number,
  groups: number[][],
  copiesOf: (id: number) => number,
  draws: number,
): number {
  if (deckSize <= 0) return 0
  const prepared = pruneGroups(groups)
  if (!prepared.length) return 0

  const n = Math.min(Math.max(0, Math.floor(draws)), deckSize)
  if (n <= 0) return 0

  let chance = 0
  const selected = new Set<number>()

  const walk = (start: number, sign: number) => {
    for (let i = start; i < prepared.length; i += 1) {
      const added: number[] = []
      for (const id of prepared[i]) {
        if (!selected.has(id)) {
          selected.add(id)
          added.push(id)
        }
      }

      if (selected.size <= n) {
        const copies = [...selected].map((id) => copiesOf(id))
        chance += sign * allPresentChance(deckSize, copies, n)
        walk(i + 1, -sign)
      }

      for (const id of added) selected.delete(id)
    }
  }

  walk(0, 1)
  return Math.min(1, Math.max(0, chance))
}
