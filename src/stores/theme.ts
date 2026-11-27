import { defineStore } from 'pinia'
import { ref } from 'vue'

const STORAGE_KEY = 'ygo-infer-theme'

export type ThemeName = 'dark' | 'light'

function readStored(): ThemeName {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark') return raw
  } catch {
    /* 忽略存储异常 */
  }
  return 'dark'
}

/**
 * 首屏直接落主题；用户手动切换时走原生 View Transitions 做交叉淡入。
 * 不支持该 API 或开了「减少动态效果」时退化成瞬间切换，不会报错。
 */
function applyTheme(name: ThemeName, animate = false) {
  if (typeof document === 'undefined') return
  const run = () => {
    document.documentElement.dataset.theme = name
  }
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown }
  const reduced =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (animate && !reduced && typeof doc.startViewTransition === 'function') {
    doc.startViewTransition(run)
  } else {
    run()
  }
}

export const useThemeStore = defineStore('theme', () => {
  const name = ref<ThemeName>(readStored())

  // 立即生效，避免首屏闪一下
  applyTheme(name.value)

  function set(next: ThemeName) {
    name.value = next
    applyTheme(next, true)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* 存储不可用时只在本次会话生效 */
    }
  }

  function toggle() {
    set(name.value === 'dark' ? 'light' : 'dark')
  }

  return { name, set, toggle }
})
