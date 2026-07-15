import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// mtg-profit-checker (5173) と同時に起動できるようポートをずらす
export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
})
