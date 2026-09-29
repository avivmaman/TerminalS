// pm2 process file: `pm2 start ecosystem.config.js`
// Launches the TerminalS window in the background (no console window) and
// restarts it only if it crashes; closing the window normally stops it.
module.exports = {
  apps: [
    {
      name: 'terminals',
      cwd: __dirname,
      script: 'node_modules/electron/cli.js',
      args: '.',
      interpreter: 'node',
      autorestart: true,
      stop_exit_codes: [0],
      max_restarts: 5,
      min_uptime: '10s',
      restart_delay: 2000,
      windowsHide: true,
    },
  ],
};
