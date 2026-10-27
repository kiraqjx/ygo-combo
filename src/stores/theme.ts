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

function applyTheme(name: ThemeName) {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = name
}

export const useThemeStore = defineStore('theme', () => {
  const name = ref<ThemeName>(readStored())

  // 立即生效，避免首屏闪一下
  applyTheme(name.value)

  function set(next: ThemeName) {
    name.value = next
    applyTheme(next)
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
