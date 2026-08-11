import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// ⚠️ MUST match your GitHub repository name exactly, or every asset 404s on
// GitHub Pages. A site published at https://<user>.github.io/LeagueManager/
// needs base '/LeagueManager/' — leading AND trailing slash.
// If you later publish to a custom domain or a <user>.github.io root repo,
// change this to '/'.
const REPO_NAME = 'LeagueManager'

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Dev server serves from '/', only the production build needs the subpath.
  base: command === 'build' ? `/${REPO_NAME}/` : '/',
}))
