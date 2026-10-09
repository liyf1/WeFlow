import { mkdirSync } from 'fs'
import { cpus } from 'os'
import { SEMANTIC_EMBEDDING_MODELS, type SemanticEmbeddingMode, type SemanticEmbeddingModelSpec } from './types'

/**
 * 本地嵌入：transformers.js（底层 onnxruntime-node）在 CPU 上运行 bge 系列模型。
 * 查找顺序：模型目录（下载缓存）→ 安装包内置模型 → 从 remoteHost 下载到模型目录。
 * 模型目录结构：<modelDir>/<modelId>/config.json、tokenizer.json、onnx/model_quantized.onnx …
 */

export interface EmbedderOptions {
  mode: SemanticEmbeddingMode
  /** 模型目录（可写，下载的模型缓存在这里） */
  modelDir: string
  /** 安装包内置模型目录（只读，可选） */
  bundledModelDir?: string
  remoteHost?: string
  threads?: number
  onProgress?: (progress: { status: string; file?: string; progress?: number }) => void
}

type FeatureExtractor = (texts: string[], options: { pooling: 'cls' | 'mean'; normalize: boolean }) => Promise<{
  data: Float32Array
  dims: number[]
}>

type TransformersModule = {
  env: Record<string, any>
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<FeatureExtractor>
}

async function loadTransformers(): Promise<TransformersModule> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@huggingface/transformers') as TransformersModule
  } catch (requireError) {
    try {
      // 某些版本只提供 ESM 入口
      const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<TransformersModule>
      return await dynamicImport('@huggingface/transformers')
    } catch {
      throw requireError
    }
  }
}

export class LocalEmbedder {
  readonly spec: SemanticEmbeddingModelSpec
  private readonly options: EmbedderOptions
  private extractorPromise: Promise<FeatureExtractor> | null = null

  constructor(options: EmbedderOptions) {
    this.options = options
    this.spec = SEMANTIC_EMBEDDING_MODELS[options.mode]
  }

  get dimensions(): number {
    return this.spec.dimensions
  }

  get modelId(): string {
    return this.spec.modelId
  }

  /** 加载（必要时下载）模型 */
  ready(): Promise<FeatureExtractor> {
    if (!this.extractorPromise) {
      this.extractorPromise = this.load().catch((error) => {
        this.extractorPromise = null
        throw error
      })
    }
    return this.extractorPromise
  }

  private async load(): Promise<FeatureExtractor> {
    const transformers = await loadTransformers()
    const cacheDir = this.options.modelDir
    mkdirSync(cacheDir, { recursive: true })
    const env = transformers.env
    env.useFSCache = true
    env.cacheDir = cacheDir
    // 先查缓存（模型目录），再查本地模型路径（内置模型），最后才联网下载
    env.localModelPath = this.options.bundledModelDir || cacheDir
    env.allowLocalModels = true
    env.allowRemoteModels = true
    if (this.options.remoteHost) {
      env.remoteHost = this.options.remoteHost.endsWith('/') ? this.options.remoteHost : `${this.options.remoteHost}/`
    }
    const threads = this.options.threads && this.options.threads > 0
      ? this.options.threads
      : Math.max(1, Math.floor(cpus().length / 2))
    return transformers.pipeline('feature-extraction', this.spec.modelId, {
      dtype: this.spec.dtype,
      device: 'cpu',
      session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
      progress_callback: (info: { status: string; file?: string; progress?: number }) => {
        this.options.onProgress?.(info)
      },
    })
  }

  private async run(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const extractor = await this.ready()
    const output = await extractor(texts, { pooling: 'cls', normalize: true })
    const dims = output.dims
    const width = dims[dims.length - 1]
    const vectors: Float32Array[] = []
    for (let index = 0; index < texts.length; index += 1) {
      vectors.push(Float32Array.from(output.data.subarray(index * width, (index + 1) * width)))
    }
    return vectors
  }

  /** 为片段文本生成向量（按批处理，避免一次占用过多内存） */
  async embedDocuments(texts: string[], batchSize = 16): Promise<Float32Array[]> {
    const vectors: Float32Array[] = []
    for (let start = 0; start < texts.length; start += batchSize) {
      vectors.push(...await this.run(texts.slice(start, start + batchSize)))
    }
    return vectors
  }

  async embedQuery(query: string): Promise<Float32Array> {
    const [vector] = await this.run([`${this.spec.queryPrefix}${query}`])
    return vector
  }
}
