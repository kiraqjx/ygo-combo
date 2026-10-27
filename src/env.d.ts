/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface ImportMetaEnv {
  /** 卡图同源代理前缀（默认 /pics/），导出 GIF 时读取像素用 */
  readonly VITE_CARD_IMG_BASE?: string
}
