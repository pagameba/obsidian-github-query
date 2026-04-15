import fs from 'node:fs/promises'
import path from 'node:path'

const rawVaultPath = process.env.OBSIDIAN_VAULT_PATH

if (!rawVaultPath) {
  console.error('Missing OBSIDIAN_VAULT_PATH environment variable.')
  console.error('Example:')
  console.error('OBSIDIAN_VAULT_PATH="$HOME/Documents/MyVault" npm run install:local')
  process.exit(1)
}

const vaultPath = rawVaultPath.replace(/\\ /g, ' ').replace(/\\~/g, '~')
const projectRoot = process.cwd()
const pluginDir = path.join(vaultPath, '.obsidian', 'plugins', 'github-query')

const filesToCopy = ['manifest.json', 'main.js', 'styles.css']

try {
  const vaultStat = await fs.stat(vaultPath)
  if (!vaultStat.isDirectory()) {
    console.error(`OBSIDIAN_VAULT_PATH is not a directory: ${vaultPath}`)
    process.exit(1)
  }
} catch {
  console.error(`Vault path does not exist or is inaccessible: ${vaultPath}`)
  console.error('Tip: pass the exact vault folder path, not the iCloud root.')
  process.exit(1)
}

await fs.mkdir(pluginDir, { recursive: true })

for (const file of filesToCopy) {
  const src = path.join(projectRoot, file)
  const dest = path.join(pluginDir, file)

  try {
    await fs.access(src)
  } catch {
    console.error(`Missing build artifact: ${src}`)
    console.error('Run `npm run build` first.')
    process.exit(1)
  }

  await fs.copyFile(src, dest)
  console.log(`Copied ${file} -> ${dest}`)
}

console.log('Install complete. In Obsidian, disable/re-enable the plugin to refresh.')
