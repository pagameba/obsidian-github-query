import esbuild from 'esbuild'

const production = process.argv.includes('--production')
const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/*'],
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  sourcemap: production ? false : 'inline',
  logLevel: 'info',
  minify: production,
  outfile: 'main.js'
})

if (production) {
  await context.rebuild()
  await context.dispose()
} else {
  await context.watch()
}
