import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * Minimal lint config with one job: catch what `vite build` cannot.
 *
 * ⚠️ WHY THIS EXISTS. esbuild does not do scope analysis on bare identifiers,
 * so a reference to a name that does not exist in scope compiles perfectly and
 * throws at runtime. That shipped a blank screen once already — `isCommish`
 * used in TradeTracker's body when it only existed as a prop of TradeCard. The
 * build was green; the app was dead the moment the Trades tab rendered.
 *
 * `no-undef` is the rule that matters here. Style rules are deliberately left
 * off: this is a correctness net, not a formatter.
 */
export default [
  { ignores: ['dist/**', 'node_modules/**', 'supabase/functions/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // ⚠️ NOT the plugin's `recommended` set. react-hooks v7 added advisory
      // rules (set-state-in-effect, static-components) that fire on idiomatic
      // code all over this app. Gating the build on those would mean either a
      // permanently red pipeline or a large refactor to satisfy style advice.
      // These two are the ones that catch actual bugs.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // JSX makes components look unused to the base parser.
      'no-unused-vars': ['warn', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
    },
  },
]
