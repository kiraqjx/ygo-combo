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

export function downloadText(filename: string, text: string, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadJson(filename: string, data: unknown) {
  downloadText(filename, JSON.stringify(data, null, 2), 'application/json')
}
