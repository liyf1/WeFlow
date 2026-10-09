/**
 * 语义检索模块测试：用 esbuild 打包 TS 测试，再以 Electron 内置 Node 运行，
 * 保证 better-sqlite3 的原生 ABI 与 electron-rebuild 后的一致。
 * 用法：npm run test:semantic
 */
const { buildSync } = require('esbuild')
const { spawnSync } = require('child_process')
const { join } = require('path')

const root = join(__dirname, '..')
const outfile = join(root, 'dist-test', 'semantic-index.test.cjs')

buildSync({
  entryPoints: [join(__dirname, 'semantic-index.test.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  external: ['better-sqlite3', 'sqlite-vec', 'jieba-wasm', 'electron'],
  logLevel: 'warning',
})

const electronBinary = require('electron')
const result = spawnSync(electronBinary, [outfile], {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
process.exit(result.status ?? 1)
