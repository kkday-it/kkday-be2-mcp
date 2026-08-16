// scripts/build-ui.mjs
import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src', 'ui')
const outDir = join(root, 'dist', 'ui')
mkdirSync(outDir, { recursive: true })

const entries = ['products-panel', 'changeset-panel', 'batch-wizard']
for (const name of entries) {
  const tsPath = join(srcDir, `${name}.ts`)
  const htmlPath = join(srcDir, `${name}.html`)
  if (!existsSync(tsPath) || !existsSync(htmlPath)) { console.warn(`skip ${name}: missing src`); continue }
  const res = await build({ entryPoints: [tsPath], bundle: true, format: 'iife', platform: 'browser', write: false })
  const js = res.outputFiles[0].text
  const template = readFileSync(htmlPath, 'utf8')
  // </script> 逃逸避免提前關標籤；用 function-replacement 避免 $-pattern 弄壞 bundle（spike 踩過的坑）。
  const escaped = js.replaceAll('</script>', '<\\/script>')
  const html = template.replace('__PANEL_JS__', () => escaped)
  writeFileSync(join(outDir, `${name}.html`), html)
  console.log(`built dist/ui/${name}.html (${(html.length / 1024).toFixed(1)} KB)`)
}
