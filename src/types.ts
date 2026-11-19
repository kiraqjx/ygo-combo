export type FrameType = 'monster' | 'spell' | 'trap'

export interface CardData {
  id: number
  name: string
  scName?: string
  jpName?: string
  enName?: string
  typeLine: string
  desc: string
  pendDesc?: string
  kinds: string[]
  race?: string
  attribute?: string
  rankLabel: '' | '★' | 'RANK' | 'LINK'
  level?: number
  atk?: number | null
  def?: number | null
  scale?: number | null
  linkMarkers?: string[]
  frame: FrameType
  /** 小写检索串：中/日/英卡名 + 效果文本 */
  blob: string
  ot?: number
  /** 用户手动录入的自定义卡（先行服 / 卡库未收录），只存在本地 */
  custom?: boolean
}

/** 卡组条目：卡号 + 卡名 + 张数（主 / 额 / 副 / 起手共用） */
export interface DeckEntry {
  id: number
  name: string
  count: number
}
