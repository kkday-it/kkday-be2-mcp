// eslint.config.mjs — 本次遷移專用最小閘門：只開兩條攸關 async 正確性的規則，零風格規則
import tseslint from 'typescript-eslint'
export default tseslint.config({
  files: ['src/**/*.ts', 'scripts/**/*.ts'],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
  },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: {
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
  },
})
