import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initTheme } from './themeStorage'
import './index.css'
import './styles.css'

initTheme()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('missing #root element')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
