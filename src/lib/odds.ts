/**
 * 从大小 size 的卡组中不放回抽 draws 张，
 * 至少抽到 copies 张同名卡中 1 张的概率（超几何分布）。
 */
export function atLeastOneChance(size: number, copies: number, draws: number): number {
  if (size <= 0 || copies <= 0 || draws <= 0) return 0
  const n = Math.min(Math.floor(draws), size)
  if (copies >= size) return 1

  // 1 - C(size - copies, n) / C(size, n)，逐张相乘避免大数阶乘
  let miss = 1
  for (let i = 0; i < n; i += 1) {
    const left = size - copies - i
    if (left <= 0) return 1
    miss *= left / (size - i)
  }
  return Math.min(1, Math.max(0, 1 - miss))
}

/** 概率 → 百分比文案 */
export function formatChance(chance: number): string {
  if (!Number.isFinite(chance) || chance <= 0) return '0%'
  const percent = chance * 100
  if (percent < 0.1) return '<0.1%'
  if (percent >= 99.95) return '100%'
  return `${percent.toFixed(1)}%`
}
