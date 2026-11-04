import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPublishableKey } from './supabase-key.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configPath = path.join(root, 'config.json')

let existing = null
try {
  existing = JSON.parse(fs.readFileSync(configPath, 'utf8'))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

const supabaseAnonKey = assertPublishableKey(
  process.env.FORGENOTES_SUPABASE_ANON_KEY || existing?.supabaseAnonKey || '',
)

const config = {
  supabaseUrl: 'https://andrimdaxlxcqgqdqrbz.supabase.co',
  supabaseAnonKey,
  forgenotesHost: 'https://notes.thecontentforge.io',
}

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
console.log('Prepared config.json with a validated public Supabase publishable key.')
