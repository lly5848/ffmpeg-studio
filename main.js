'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const { startServer } = require('./server.js');

let mainWindow = null;
let serverRef = null;
let activePort = null;

// 单实例锁：重复双击只聚焦已有窗口，避免多个实例抢同一端口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}

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

  // 始终用后端实际监听的端口加载页面（端口可能被自动顺延）
  const port = activePort || process.env.PORT || 5180;
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
  const { server, port } = await startServer();
  serverRef = server;
  activePort = port;
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 重复启动：聚焦已存在的窗口，而不是新开一个抢端口
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出前优雅关闭后端，释放端口，避免残留进程占用
app.on('before-quit', () => {
  if (serverRef && typeof serverRef.close === 'function') {
    try { serverRef.close(); } catch (e) { /* ignore */ }
  }
});
