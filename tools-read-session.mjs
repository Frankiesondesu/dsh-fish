// 读她的会话记录。文件是「多帧拼接」的 zstd，需要一帧一帧解。
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const n = Number(process.argv[3] ?? 6)
const buf = readFileSync(file)

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const offsets = []
for (let i = buf.indexOf(MAGIC); i !== -1; i = buf.indexOf(MAGIC, i + 1)) offsets.push(i)

let text = ''
for (let k = 0; k < offsets.length; k++) {
  const start = offsets[k]
  const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
  try {
    text += zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
  } catch { /* 不是真帧边界，跳过 */ }
}

const lines = text.split('\n').filter(Boolean)
console.log(`解出 ${lines.length} 条记录，看最后 ${n} 条：\n`)

for (const line of lines.slice(-n)) {
  let o
  try { o = JSON.parse(line) } catch { continue }
  const c = o.content ?? o.message?.content
  let body = ''
  if (typeof c === 'string') body = c
  else if (Array.isArray(c)) body = c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ')
  if (!body && typeof o.text === 'string') body = o.text
  console.log(`--- role=${o.role ?? '-'} type=${o.type ?? '-'}`)
  console.log((body || '(无文本)').slice(0, 600))
  console.log()
}
