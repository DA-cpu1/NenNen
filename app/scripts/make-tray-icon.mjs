/**
 * 一次性小工具：生成托盘图标（16×16 淡紫色圆点 PNG）并打印 base64。
 * 为什么不用现成图片文件：托盘图标只有一个颜色小圆（设计稿 full-ui-v1
 * 的「tiny lavender app tray icon」），不值得为它引入图片资产和路径配置；
 * 生成后把 base64 直接写进 desktop/main.ts，程序启动时从字符串还原，
 * 开发/打包都不用操心文件在哪。
 *
 * 用法：node scripts/make-tray-icon.mjs
 * 输出：一行 base64（PNG 字节流），复制进 main.ts 的 TRAY_ICON_PNG_BASE64。
 * PNG 是一种「无损压缩的位图格式」：文件头写宽高和颜色格式，中间是
 * 压缩的像素数据，每段末尾带 CRC 校验和（一种「内容对不对得上」的
 * 数字指纹，传输坏了能被发现）。
 */
import { deflateSync } from 'node:zlib'

/** PNG 尺寸：Windows 托盘标准小图标大小 */
const SIZE = 16
/** 图标颜色：淡紫（与界面主题一致）；深一档的紫做圆边 */
const FILL = [0xb4, 0xa2, 0xe8, 0xff]
const EDGE = [0x6b, 0x55, 0xb8, 0xff]

/** 画一帧像素：圆心在中央、半径按比例，圆边 1 像素 */
function makePixels() {
  const rows = []
  const center = (SIZE - 1) / 2
  const radius = SIZE / 2 - 0.5 // 半径略收，留出边的位置
  for (let y = 0; y < SIZE; y += 1) {
    const row = Buffer.alloc(1 + SIZE * 4) // 行首 1 字节过滤器（0=不过滤）+ 每像素 RGBA
    for (let x = 0; x < SIZE; x += 1) {
      const dist = Math.hypot(x - center, y - center)
      const [r, g, b, a] = dist <= radius - 1.1 ? FILL : dist <= radius ? EDGE : [0, 0, 0, 0]
      const offset = 1 + x * 4
      row[offset] = r
      row[offset + 1] = g
      row[offset + 2] = b
      row[offset + 3] = a
    }
    rows.push(row)
  }
  return Buffer.concat(rows)
}

/** CRC32：PNG 每段要求的校验算法（查表法，标准多项式） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 拼一段 PNG 块：长度 + 类型 + 数据 + CRC */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

// PNG 文件 = 签名 + IHDR（宽高与颜色格式）+ IDAT（压缩像素）+ IEND（结束）
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0) // 宽
ihdr.writeUInt32BE(SIZE, 4) // 高
ihdr[8] = 8 // 每通道 8 位
ihdr[9] = 6 // 颜色类型 6 = RGBA（带透明）
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(makePixels(), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

process.stdout.write(png.toString('base64'))
