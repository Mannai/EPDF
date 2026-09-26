// Electron main process of the text rendering harness (tests only). It opens one window with page.html, where
// PDF.js renders PDFs produced by the text engine and Chromium's own text engine renders the same text, so the two
// can be compared pixel-wise by tests/e2e/text-engine.spec.ts. Nothing here ships with the app.
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('disable-lcd-text')
app.disableHardwareAcceleration()

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1100,
    height: 900,
    show: false,
    webPreferences: { webSecurity: false, contextIsolation: false, nodeIntegration: false, backgroundThrottling: false }
  })
  win.loadFile(path.join(__dirname, 'page.html'), { query: { root: process.env.EPDF_HARNESS_ROOT || '' } })
})

app.on('window-all-closed', () => app.quit())
