'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('terminals', {
  shells: () => ipcRenderer.invoke('shells:list'),
  pty: {
    create: (shellId, cols, rows) => ipcRenderer.invoke('pty:create', shellId, cols, rows),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('pty:kill', id),
    onData: (cb) => subscribe('pty:data', cb),
    onExit: (cb) => subscribe('pty:exit', cb),
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    add: (entry) => ipcRenderer.invoke('history:add', entry),
    setExitCode: (id, code) => ipcRenderer.send('history:exit', id, code),
    remove: (id) => ipcRenderer.invoke('history:remove', id),
    clear: () => ipcRenderer.invoke('history:clear'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  pins: {
    list: () => ipcRenderer.invoke('pins:list'),
    add: (pin) => ipcRenderer.invoke('pins:add', pin),
    remove: (id) => ipcRenderer.invoke('pins:remove', id),
    move: (id, delta) => ipcRenderer.invoke('pins:move', id, delta),
  },
  ai: {
    suggest: (req) => ipcRenderer.invoke('ai:suggest', req),
    cancel: () => ipcRenderer.send('ai:cancel'),
    fix: (req) => ipcRenderer.invoke('ai:fix', req),
    translate: (req) => ipcRenderer.invoke('ai:translate', req),
    test: () => ipcRenderer.invoke('ai:test'),
    setKey: (provider, key) => ipcRenderer.invoke('ai:setKey', provider, key),
    clearKey: (provider) => ipcRenderer.invoke('ai:clearKey', provider),
  },
  profiles: {
    get: () => ipcRenderer.invoke('profiles:get'),
    saveEnv: (v) => ipcRenderer.invoke('profiles:saveEnv', v),
    deleteEnv: (id) => ipcRenderer.invoke('profiles:deleteEnv', id),
    moveEnv: (id, delta) => ipcRenderer.invoke('profiles:moveEnv', id, delta),
    saveScript: (kind, text) => ipcRenderer.invoke('profiles:saveScript', kind, text),
  },
  guard: {
    check: (command, cwd) => ipcRenderer.invoke('guard:check', command, cwd),
  },
  translate: {
    detect: (text, shellKind) => ipcRenderer.invoke('translate:detect', text, shellKind),
    local: (command, from, to, psVersion) => ipcRenderer.invoke('translate:local', command, from, to, psVersion),
  },
  usage: {
    get: () => ipcRenderer.invoke('usage:get'),
    reset: () => ipcRenderer.invoke('usage:reset'),
  },
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
});
