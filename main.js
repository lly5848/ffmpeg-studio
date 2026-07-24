'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const { startServer } = require('./server.js');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 620,
    backgroundColor: '#0f1420',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    title: 'FFmpeg Studio',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  const port = process.env.PORT || 5180;
  mainWindow.loadURL(`http://localhost:${port}`);

  // Open external links in the default browser instead of a new window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  // Keep uploads/outputs in the user's AppData — the asar bundle is read-only.
  process.env.FFMPEG_STUDIO_DATA = path.join(app.getPath('userData'), 'data');
  await startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
