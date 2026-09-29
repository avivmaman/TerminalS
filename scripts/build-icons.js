'use strict';

// Rasterises assets/icon.svg into assets/icon.png (512px) and a multi-size
// assets/icon.ico using Electron's own renderer, so no image dependencies are
// needed. Run with: npm run icons
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'assets', 'icon.svg'), 'utf8');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// Draws the SVG onto a canvas at the exact size (keeps transparency) and
// returns PNG bytes.
async function render(win, size) {
  const svgUrl = `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`;
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = ${size};
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, ${size}, ${size});
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('SVG failed to load'));
    img.src = ${JSON.stringify(svgUrl)};
  })`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

// ICO container with PNG-encoded entries (supported since Windows Vista).
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL('about:blank');
  const entries = [];
  for (const size of ICO_SIZES) entries.push({ size, png: await render(win, size) });
  fs.writeFileSync(path.join(ROOT, 'assets', 'icon.ico'), buildIco(entries));
  fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), await render(win, 512));
  console.log(`icons: wrote icon.ico (${ICO_SIZES.join(', ')}) and icon.png (512)`);
  app.exit(0);
});
