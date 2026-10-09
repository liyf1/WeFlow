/**
 * 下载语义检索的嵌入模型到 resources/models，打包时随安装包分发（离线可用）。
 *
 * 用法：
 *   node scripts/download-semantic-model.cjs                 # 标准模型（bge-small-zh，约 30 MB）
 *   node scripts/download-semantic-model.cjs --model precise # 高精度模型（bge-m3，约 600 MB）
 *   node scripts/download-semantic-model.cjs --model all
 *   node scripts/download-semantic-model.cjs --host https://hf-mirror.com
 *
 * 目录结构与应用运行时的模型目录一致：resources/models/<modelId>/config.json …
 * 也可以把生成的 <modelId> 文件夹直接复制到应用设置的「模型目录」下离线使用。
 */
const fs = require('node:fs')
const path = require('node:path')

const MODELS = {
  standard: 'Xenova/bge-small-zh-v1.5',
  precise: 'Xenova/bge-m3',
}

const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
]

function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

async function download(url, target) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const temp = `${target}.part`
      const buffer = Buffer.from(await response.arrayBuffer())
      fs.writeFileSync(temp, buffer)
      fs.renameSync(temp, target)
      return buffer.length
    } catch (error) {
      if (attempt === 3) throw new Error(`${url} 下载失败：${error.message}`)
      console.warn(`  重试 ${attempt}/3：${error.message}`)
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
    }
  }
  return 0
}

async function main() {
  const which = argValue('--model', 'standard')
  const host = argValue('--host', 'https://huggingface.co').replace(/\/+$/, '')
  const outRoot = path.resolve(argValue('--out', path.join(__dirname, '..', 'resources', 'models')))
  const modelIds = which === 'all' ? Object.values(MODELS) : [MODELS[which]]
  if (modelIds.some((id) => !id)) {
    console.error(`未知模型：${which}（可选 standard / precise / all）`)
    process.exit(1)
  }
  for (const modelId of modelIds) {
    console.log(`下载 ${modelId} → ${path.join(outRoot, modelId)}`)
    for (const file of FILES) {
      const target = path.join(outRoot, modelId, file)
      if (fs.existsSync(target) && fs.statSync(target).size > 0) {
        console.log(`  已存在 ${file}`)
        continue
      }
      const bytes = await download(`${host}/${modelId}/resolve/main/${file}`, target)
      console.log(`  ${file}  ${(bytes / 1024 / 1024).toFixed(1)} MB`)
    }
  }
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
