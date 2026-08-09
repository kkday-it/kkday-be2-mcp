import { loadConfig } from '../src/config.js'
import { openDb } from '../src/store/db.js'
import { TokenStore } from '../src/store/tokenStore.js'
import { AuthServiceClient } from '../src/auth/authServiceClient.js'
import { enrollUser } from '../src/auth/enroll.js'
import { parseArgs } from 'node:util'

// Enroll a pilot user. Modes:
//   npm run bootstrap-user                       -> login with AUTH_email/AUTH_pwd from .env
//   npm run bootstrap-user -- --otp 123456       -> same, with 2FA OTP
//   npm run bootstrap-user -- --code <authCode>  -> browser-login fallback (paste authorizationCode
//        from https://auth-220.sit.kkday.com/auth/be2/login?loginFlow=POPUP if REST login is CSRF-blocked)
// Prints the static bearer ONCE. It is stored only as a sha256 hash.

const { values } = parseArgs({ options: { otp: { type: 'string' }, code: { type: 'string' }, label: { type: 'string' } } })
const cfg = loadConfig()
const store = new TokenStore(openDb(cfg.dbPath))
const auth = new AuthServiceClient({ baseUrl: cfg.authsvcUrl, serviceKey: cfg.serviceKey })
const userLabel = values.label ?? process.env.AUTH_email ?? 'unknown-pilot'

const input = values.code
  ? { userLabel, code: values.code }
  : { userLabel, account: process.env.AUTH_email!, password: process.env.AUTH_pwd!, otp: values.otp }

enrollUser({ store, auth }, input).then(({ bearer }) => {
  console.log(`Enrolled ${userLabel}.`)
  console.log('Static bearer (shown once, store it in your Claude Code MCP config):')
  console.log(bearer)
  console.log(`\nClaude Code: claude mcp add be2-mcp --transport http http://127.0.0.1:${cfg.port}/mcp --header "Authorization: Bearer ${bearer}"`)
}).catch(e => { console.error('enroll failed:', e.code ?? '', e.message); process.exit(1) })
