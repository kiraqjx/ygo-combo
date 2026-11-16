/**
 * 把图片写进剪贴板（微信 / QQ 可以直接 Ctrl+V 发送）。
 *
 * 浏览器只接受 image/png，webp 需要先转一遍；
 * 剪贴板写入必须在安全上下文（https / localhost）且由用户手势触发。
 */

async function toPngBlob(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close?.()
    throw new Error('当前浏览器无法转换图片格式')
  }
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close?.()

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((png) => {
      if (png) resolve(png)
      else reject(new Error('图片转换失败'))
    }, 'image/png')
  })
}

export function canCopyImage(): boolean {
  return typeof ClipboardItem !== 'undefined' && Boolean(navigator.clipboard?.write)
}

export async function copyImageToClipboard(blob: Blob): Promise<void> {
  if (!canCopyImage()) {
    throw new Error('当前浏览器不支持复制图片，请改用下载')
  }
  if (!window.isSecureContext) {
    throw new Error('复制图片需要 https 或 localhost 环境，请改用下载')
  }

  const png = blob.type === 'image/png' ? blob : await toPngBlob(blob)
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}
