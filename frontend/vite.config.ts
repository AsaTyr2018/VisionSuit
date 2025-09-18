import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const parsePort = (value?: string) => {
  if (!value) {
    return 5173
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? 5173 : parsed
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: parsePort(process.env.FRONTEND_PORT),
  },
})
