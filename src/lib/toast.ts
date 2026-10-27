import { ref } from 'vue'

export interface ToastItem {
  id: number
  message: string
  error?: boolean
}

export const toasts = ref<ToastItem[]>([])

export function toast(message: string, error = false) {
  const id = Date.now() + Math.random()
  toasts.value.push({ id, message, error })
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }, 2800)
}

export async function copyText(text: string, okMessage = '已复制到剪贴板') {
  try {
    await navigator.clipboard.writeText(text)
    toast(okMessage)
  } catch {
    toast('复制失败，请手动选择文本', true)
  }
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
