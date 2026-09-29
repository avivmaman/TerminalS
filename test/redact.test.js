'use strict';

const assert = require('node:assert/strict');
const { redact, looksSensitive, MASK } = require('../src/main/redact');

const leaks = [
  ['$env:API_KEY = "abc123secret"', 'abc123secret'],
  ['export GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaa', 'ghp_aaaaaaaaaaaaaaaaaaaaaaaa'],
  ['mysql -u root -pHunter2 mydb', 'Hunter2'],
  ['sshpass -p hunter2 ssh me@host', 'hunter2'],
  ['curl -H "Authorization: Bearer abc.def.ghi" https://x', 'abc.def.ghi'],
  ['git clone https://bob:s3cr3t@github.com/org/repo', 's3cr3t'],
  ['az login --password Sup3rS3cret -u me', 'Sup3rS3cret'],
  ['Connect-Thing -Password p@ss -Server x', 'p@ss'],
  ['sqlcmd "Server=x;User Id=sa;Password=Pa55;"', 'Pa55'],
  ['$s = ConvertTo-SecureString "PlainPw" -AsPlainText -Force', 'PlainPw'],
  ['set ANTHROPIC_API_KEY=sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa', 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa'],
  ['aws configure set aws_access_key_id AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP'],
];

for (const [input, secret] of leaks) {
  const out = redact(input);
  assert.ok(!out.includes(secret), `secret leaked: ${input} -> ${out}`);
  assert.ok(out.includes(MASK), `no mask applied: ${input} -> ${out}`);
  assert.ok(looksSensitive(input));
}

const harmless = [
  'git status',
  'mkdir -p src/components',
  'docker run -p 8080:80 nginx',
  'Get-ChildItem -Recurse -Filter *.log',
  'npm install --save-dev electron',
  'cd D:\\Projects\\TerminalS',
  'pwd',
];

for (const input of harmless) {
  assert.equal(redact(input), input, `over-redacted: ${input}`);
  assert.equal(looksSensitive(input), false);
}

console.log(`redact: ${leaks.length + harmless.length} cases passed`);
