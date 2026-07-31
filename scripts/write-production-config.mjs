import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configPath = path.join(root, 'config.json')

function jwtRole(value) {
  const parts = String(value || '').trim().split('.')
  if (parts.length !== 3) throw new Error('Supabase key must be a JWT')
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role
  } catch {
    throw new Error('Supabase key has an invalid JWT payload')
  }
}

let existing = null
try {
  existing = JSON.parse(fs.readFileSync(configPath, 'utf8'))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

const supabaseAnonKey = String(
  process.env.FORGENOTES_SUPABASE_ANON_KEY || existing?.supabaseAnonKey || '',
).trim()

if (!supabaseAnonKey) {
  throw new Error(
    'Missing FORGENOTES_SUPABASE_ANON_KEY (or a local config.json). ' +
    'The production build will not be created without its public anon key.',
  )
}

const role = jwtRole(supabaseAnonKey)
if (role !== 'anon') {
  throw new Error(`Refusing to package a Supabase JWT with role ${JSON.stringify(role)}; expected "anon"`)
}

const config = {
  supabaseUrl: 'https://andrimdaxlxcqgqdqrbz.supabase.co',
  supabaseAnonKey,
  forgenotesHost: 'https://notes.thecontentforge.io',
}

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
console.log('Prepared config.json with a validated public Supabase anon key.')
