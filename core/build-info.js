const path = require('path');
const { execFileSync } = require('child_process');
let gitCommit = process.env.MY_AGENTS_BUILD_COMMIT || '';
if (!gitCommit && require('fs').existsSync(path.join(__dirname, '..', '.git'))) { try { gitCommit = execFileSync('git', ['-C', path.resolve(__dirname, '..'), 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore','pipe','ignore'] }).trim(); } catch {} }
const buildInfo = Object.freeze({ version: require('../package.json').version, gitCommit, startedAt: new Date().toISOString(), protocolVersion: 2 });
module.exports = { buildInfo };
