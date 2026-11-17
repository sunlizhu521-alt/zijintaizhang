const fs = require('node:fs');
const path = require('node:path');
const projectRoot = path.resolve(__dirname, '..', '..');
const release = path.basename(__dirname);
const config = JSON.parse(fs.readFileSync(path.join(projectRoot, 'shared/config.json'), 'utf8'));
if (!/^[0-9a-f]{40}$/.test(release) || path.basename(path.dirname(__dirname)) !== 'releases') {
  throw new Error('PM2 configuration must run from a managed release directory.');
}
if (config.port !== 4010 || config.host !== '127.0.0.1' || config.trustProxy !== 'loopback' || config.publicOrigin !== 'https://129.211.9.242') {
  throw new Error('Deployment settings differ from the reviewed configuration.');
}
module.exports = {
  apps: [{
    name: 'zijintaizhang', cwd: __dirname, script: path.join(__dirname, 'server/index.js'),
    interpreter: path.join(__dirname, 'runtime/node'), node_args: '--max-old-space-size=256',
    instances: 1, exec_mode: 'fork', autorestart: true, min_uptime: 10000,
    max_restarts: 10, restart_delay: 2000, kill_timeout: 10000, max_memory_restart: '640M',
    out_file: path.join(projectRoot, 'shared/logs/out.log'),
    error_file: path.join(projectRoot, 'shared/logs/error.log'),
    merge_logs: true, log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    env: {
      NODE_ENV: 'production', HOST: config.host, PORT: config.port,
      PUBLIC_ORIGIN: config.publicOrigin, TRUST_PROXY: config.trustProxy,
      DATA_DIR: path.join(projectRoot, 'shared/data'), RELEASE_SHA: release, TZ: 'Asia/Shanghai',
    },
  }],
};
