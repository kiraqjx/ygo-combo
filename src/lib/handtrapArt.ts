import { CARD_PLACEHOLDER, cardImageProxyUrl } from './cardDb'

/**
 * 手坑 id → 卡号。
 *
 * id 是事件流判定（`replayHandtraps.ts` / `drawHandtraps.ts`）里用的标识，
 * 不是卡号；报告要显示卡图才需要这张表。新增手坑时两边一起加。
 */
const HANDTRAP_CARD_IDS: Record<string, number> = {
  // 打断型
  ash: 14558127, // 灰流丽
  'dominus-impulse': 40366667, // 灵王的波动
  imperm: 10045474, // 无限泡影
  'ghost-belle': 73642296, // 屋敷童
  'ghost-rabbit': 59438930, // 幽鬼兔
  'lock-bird': 94145021, // 小丑与锁鸟
  nibiru: 27204311, // 原始生命态 尼比鲁
  // 抽卡型
  'maxx-c': 23434538, // 增殖的 G
  purulia: 84192580, // 欢聚友伴·噗露莉娅
  fuwalos: 42141493, // 欢聚友伴·浮华洛丝
  meowls: 87126721, // 欢聚友伴·喵露丝
}

/** 手坑卡图（同源，缺少映射时给占位图） */
export function handtrapCardImage(id: string): string {
  const code = HANDTRAP_CARD_IDS[id]
  return code ? cardImageProxyUrl(code) : CARD_PLACEHOLDER
}
