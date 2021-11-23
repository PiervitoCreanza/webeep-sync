import path from 'path'
import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    nativeImage,
    nativeTheme,
    powerSaveBlocker,
    Tray,
} from 'electron'

import { loginManager } from './helpers/login'
import { moodleClient } from './helpers/moodle'
import { initalizeStore, store } from './helpers/store'
import { downloadManager } from './helpers/download'

// This allows TypeScript to pick up the magic constant that's auto-generated by Forge's Webpack
// plugin that tells the Electron app where to look for the Webpack-bundled app code (depending on
// whether you're running in development or production).
declare const MAIN_WINDOW_WEBPACK_ENTRY: string
const __static = path.join(__dirname, 'static')

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) { // eslint-disable-line global-require
    app.quit()
}

// exits if another instance is already open
if (!app.requestSingleInstanceLock()) {
    app.exit()
}

let tray: Tray = null
let iconImg = nativeImage.createFromPath(path.join(__static, '/icons/icon.ico'))
let trayImg = nativeImage.createFromPath(path.join(__static, '/icons/tray.png'))

let psbID: number

downloadManager.on('sync', () => {
    psbID = powerSaveBlocker.start('prevent-app-suspension')
    updateTrayContext()
})
downloadManager.on('stop', () => {
    if (powerSaveBlocker.isStarted(psbID)) powerSaveBlocker.stop(psbID)
    updateTrayContext()
})

const createWindow = (): void => {
    app.dock?.show()
    // Create the browser window.
    const mainWindow = new BrowserWindow({
        height: 600,
        width: 800,
        autoHideMenuBar: true,
        titleBarStyle: 'hidden',
        titleBarOverlay: true,
        minHeight: 400,
        minWidth: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: iconImg
    })

    const send = (channel: string, ...args: any[]) => {
        if (!mainWindow.isDestroyed())
            mainWindow.webContents.send(channel, ...args)
    }

    // and load the index.html of the app.
    mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY)
    loginManager.on('token', () => send('is-logged', true))
    loginManager.on('logout', () => send('is-logged', false))
    moodleClient.on('network_event', conn => send('network_event', conn))
    moodleClient.on('username', username => send('username', username))
    if (moodleClient.username) send('username', moodleClient.username)

    downloadManager.on('sync', () => send('syncing', true))
    downloadManager.on('stop', result => {
        send('syncing', false)
        send('sync-result', result)
    })
    downloadManager.on('progress', progress => send('progress', progress))
    downloadManager.on('state', state => send('download-state', state))
    downloadManager.on('new-files', files => send('new-files', files))

    moodleClient.on('reconnected', async () => send('courses-return', await moodleClient.getCourses()))
}

function focus() {
    let windows = BrowserWindow.getAllWindows()
    if (windows.length === 0) createWindow()
    else windows[0].focus()
}

function setupTray() {
    tray = new Tray(trayImg)
    tray.setToolTip('Webeep Sync')
    tray.on('click', () => {
        process.platform === 'win32' ? focus() : undefined
    })
}

async function updateTrayContext() {
    if (!tray) return
    await initalizeStore()
    const s = downloadManager.syncing
    const ae = store.data.settings.autosyncEnabled
    tray.setContextMenu(Menu.buildFromTemplate([
        // { label: 'WebeepSync', type: 'submenu' },
        { label: 'Open', click: () => focus() },
        { type: 'separator' },
        {
            label: s ? 'stop syncing' : 'sync now',
            sublabel: s ? 'syncing in progress...' : undefined,
            click: () => s ? downloadManager.stop() : downloadManager.sync()
        },
        {
            label: 'turn autosync ' + (ae ? 'off' : 'on'),
            icon: path.join(__static, 'icons', ae ? 'pause.png' : 'play.png'),
            click: async () => {
                await downloadManager.setAutosync(!ae)
                BrowserWindow.getAllWindows()[0]?.webContents.send('autosync', !ae)
                updateTrayContext()
            }
        },
        { type: 'separator' },
        { label: 'Quit', role: 'quit' }
    ]))
}

// When another instance gets launched, focuses the main window
app.on('second-instance', () => {
    focus()
})

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
    createWindow()
    setupTray()
    await updateTrayContext()
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
    app.dock?.hide()
    // app.quit()
})

app.on('activate', () => {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
    }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

ipcMain.on('get-context', e => {
    e.reply('is-logged', loginManager.isLogged)
    e.reply('username', moodleClient.username)
    e.reply('syncing', downloadManager.syncing)
    e.reply('network_event', moodleClient.connected)
})

ipcMain.on('logout', async e => {
    await loginManager.logout()
})

ipcMain.on('courses', async e => {
    e.reply('courses-return', await moodleClient.getCourses())
})

ipcMain.on('request-login', async e => {
    await loginManager.createLoginWindow()
})

ipcMain.on('set-should-sync', async (e, courseid: number, shouldSync: boolean) => {
    await initalizeStore()
    store.data.persistence.courses[courseid].shouldSync = shouldSync
    await store.write()
})

ipcMain.on('sync-start', e => downloadManager.sync())
ipcMain.on('sync-stop', e => downloadManager.stop())

ipcMain.on('sync-settings', async e => {
    await initalizeStore()
    e.reply('download-path', store.data.settings.downloadPath)
    e.reply('autosync', store.data.settings.autosyncEnabled)
    e.reply('autosync-interval', store.data.settings.autosyncInterval)
})

ipcMain.on('select-download-path', async e => {
    let path = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory',],
        title: 'select download folder'
    })
    if (!path.canceled) {
        store.data.settings.downloadPath = path.filePaths[0]
        e.reply('download-path', path.filePaths[0])
        await store.write()
    }
})
ipcMain.on('set-autosync', async (e, sync: boolean) => {
    await downloadManager.setAutosync(sync)
    e.reply('autosync', sync)
    await updateTrayContext()
})

ipcMain.on('set-autosync-interval', async (e, interval: number) => {
    store.data.settings.autosyncInterval = interval
    e.reply('autosync-interval', interval)
    await store.write()
})

ipcMain.handle('lastsynced', e => {
    return store.data.persistence.lastSynced
})

ipcMain.handle('settings', e => {
    let settingsCopy = { ...store.data.settings }
    // this three settings are not managed in the settings menu
    delete settingsCopy.autosyncEnabled
    delete settingsCopy.downloadPath
    delete settingsCopy.autosyncInterval
    return settingsCopy
})
ipcMain.handle('set-settings', async (e, newSettings) => {
    store.data.settings = { ...store.data.settings, ...newSettings }
    await store.write()
})

ipcMain.handle('get-native-theme', e => {
    return nativeTheme.themeSource
})
ipcMain.on('set-native-theme', (e, theme) => {
    nativeTheme.themeSource = theme
})