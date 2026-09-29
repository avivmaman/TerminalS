'use strict';

// Updates from GitHub Releases (electron-updater). The installed build
// downloads a newer release in the background and installs it on restart. The
// portable .exe can't replace itself, so it only reports the new version and
// links to the release page. Beta builds (versions like 0.2.0-beta.1) also
// receive newer betas; stable builds only receive stable releases.

const { app } = require('electron');
const store = require('./store');

const RELEASES_URL = 'https://github.com/avivmaman/TerminalS/releases';
const FIRST_CHECK_MS = 10 * 1000;
const RECHECK_MS = 6 * 60 * 60 * 1000;

let updater = null;
let notify = () => {};
let timer = null;
let state = { status: 'idle' };

function isPortable() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
}

// status: disabled | idle | checking | none | available | downloading | ready | error
function setState(next) {
  state = { ...next, portable: isPortable(), releasesUrl: RELEASES_URL };
  notify(state);
}

function getState() {
  return state;
}

function releaseUrl(version) {
  return version ? `${RELEASES_URL}/tag/v${version}` : RELEASES_URL;
}

function describeError(err) {
  const msg = String((err && err.message) || err || '');
  if (/net::|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET/.test(msg)) return 'Could not reach GitHub. Check your connection.';
  if (/\b404\b/.test(msg)) return 'No published release found.';
  return 'Update check failed.';
}

async function check() {
  if (!updater) return state;
  if (['checking', 'downloading', 'ready'].includes(state.status)) return state;
  setState({ status: 'checking' });
  try {
    await updater.checkForUpdates();
  } catch (err) {
    setState({ status: 'error', error: describeError(err) });
  }
  return state;
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if (!updater || !store.getSettings().updates.auto) return;
  setTimeout(check, FIRST_CHECK_MS);
  timer = setInterval(check, RECHECK_MS);
}

// Silent install, then relaunch. before-quit still runs, so history is flushed.
function install() {
  if (updater && state.status === 'ready') updater.quitAndInstall(true, true);
}

function init(onChange) {
  notify = onChange;
  // Only packaged builds have release metadata (app-update.yml) to update from.
  if (!app.isPackaged) {
    setState({ status: 'disabled', reason: 'Updates are only available in the installed app.' });
    return;
  }
  const { autoUpdater } = require('electron-updater');
  updater = autoUpdater;
  updater.autoDownload = !isPortable();
  updater.autoInstallOnAppQuit = !isPortable();
  updater.logger = null;

  updater.on('update-available', (info) => {
    const version = info && info.version;
    setState(isPortable()
      ? { status: 'available', version, url: releaseUrl(version) }
      : { status: 'downloading', version, percent: 0 });
  });
  updater.on('update-not-available', () => setState({ status: 'none', checkedAt: Date.now() }));
  updater.on('download-progress', (p) => {
    setState({ status: 'downloading', version: state.version, percent: Math.round((p && p.percent) || 0) });
  });
  updater.on('update-downloaded', (info) => setState({ status: 'ready', version: info && info.version }));
  updater.on('error', (err) => setState({ status: 'error', error: describeError(err) }));

  setState({ status: 'idle' });
  schedule();
}

module.exports = { init, check, install, getState, schedule };
