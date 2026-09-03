// tools/lint/eslint.config.mjs — 本次遷移專用最小閘門：只開兩條攸關 async 正確性的規則，零風格規則
//
// 此設定檔與其 eslint / typescript-eslint 依賴獨立安裝在 tools/lint/（自帶 typescript@5.9），
// 不動根目錄 typescript@7（tsc typecheck/build 用）。見 tools/lint/package.json。
import { fileURLToPath } from 'node:url'
import tseslint from 'typescript-eslint'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

export default tseslint.config({
  files: ['src/**/*.ts', 'scripts/**/*.ts'],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { projectService: true, tsconfigRootDir: repoRoot },
  },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: {
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
  },
})
