import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { HandtrapDef } from '@/lib/handtraps'
import { BUILTIN_HANDTRAPS, syncHandtrapRegistry } from '@/lib/handtraps'
import { uid } from '@/lib/infer'

const STORAGE_KEY = 'ygo-infer-handtraps-v1'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * 历史上存过两代配色（初版霓虹、纸色墨调），
 * 统一迁移到当前的高对比亮色，避免深底上手坑看不清。
 */
const LEGACY_TONES: Record<string, string> = {
  // 初版霓虹
  '#5fe3a1': '#26cd4d',
  '#79d0ff': '#71b7ff',
  '#8ea7ff': '#7ea8ff',
  '#c9a6ff': '#a371f7',
  '#ffb86b': '#ff9b57',
  '#ff9db1': '#ff6a69',
  '#ffd479': '#f0b72f',
  '#f2a8ff': '#ff7bd5',
  '#ff8f6b': '#ff8f6b',
  '#9bb0c9': '#9ea7b3',
  '#b7e4c7': '#56d364',
  '#a5d8ff': '#39c5cf',
  // 纸色墨调
  '#2f6b52': '#26cd4d',
  '#1f5f7a': '#71b7ff',
  '#3a4f7a': '#7ea8ff',
  '#6b4a8a': '#a371f7',
  '#a8621a': '#ff9b57',
  '#a8352a': '#ff6a69',
  '#8d6a12': '#f0b72f',
  '#8a3a7a': '#ff7bd5',
  '#b04a24': '#ff8f6b',
  '#9ea7b3': '#9ea7b3',
  '#4a7a5c': '#56d364',
  '#34666f': '#39c5cf',
}

function migrateTone(tone: string): string {
  return LEGACY_TONES[tone.toLowerCase()] || tone
}

function readStored(): HandtrapDef[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length) {
        return (parsed as HandtrapDef[]).map((def) => ({
          ...def,
          tone: migrateTone(def.tone || '#9ea7b3'),
        }))
      }
    }
  } catch {
    /* 本地数据损坏时回退到内置列表 */
  }
  return clone(BUILTIN_HANDTRAPS)
}

/**
 * 用户自定义手坑。
 * 每次提交都会同步给 `@/lib/handtraps` 的注册表，
 * 这样推理内核（timeline / infer）不用改签名也能用上自定义手坑。
 */
export const useHandtrapStore = defineStore('handtraps', () => {
  const defs = ref<HandtrapDef[]>(readStored())
  /** 每次改动 +1，让依赖手坑列表的分析结果重新计算 */
  const version = ref(0)

  const map = computed(() => Object.fromEntries(defs.value.map((def) => [def.id, def])))

  syncHandtrapRegistry(defs.value)

  /** 提交：同步内核注册表 + 持久化 + 通知依赖方 */
  function commit() {
    syncHandtrapRegistry(defs.value)
    version.value += 1
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(defs.value))
    } catch {
      /* 存储不可用时只在本次会话生效 */
    }
  }

  function blank(): HandtrapDef {
    return {
      id: `custom-${uid()}`,
      name: '',
      category: 'negate',
      tone: '#ff6a69',
      summary: '',
      rule: '',
    }
  }

  function save(def: HandtrapDef) {
    const index = defs.value.findIndex((item) => item.id === def.id)
    if (index >= 0) defs.value.splice(index, 1, { ...def })
    else defs.value.push({ ...def })
    commit()
  }

  function remove(id: string) {
    defs.value = defs.value.filter((item) => item.id !== id)
    commit()
  }

  function reset() {
    defs.value = clone(BUILTIN_HANDTRAPS)
    commit()
  }

  return { defs, map, version, blank, save, remove, reset }
})
