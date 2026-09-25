import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'pdfjs-dist/web/pdf_viewer.css'
import './index.css'
import './features' // registers every feature (core, and any under features/<name>/)
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
