'use strict';

const assert = require('node:assert/strict');
const { nextVersion } = require('../scripts/next-version');

assert.equal(nextVersion('0.2.0-beta.1', []), '0.2.0-beta.1');
assert.equal(nextVersion('0.2.0-beta.1', ['v0.2.0-beta.1']), '0.2.0-beta.2');
assert.equal(nextVersion('0.2.0-beta.1', ['v0.2.0-beta.1', 'v0.2.0-beta.2', 'v0.2.0-beta.7', 'v0.3.0-beta.9']), '0.2.0-beta.8');
assert.equal(nextVersion('0.2.0-beta.5', ['v0.2.0-beta.1']), '0.2.0-beta.5');
assert.equal(nextVersion('0.2.0-beta.3', ['v0.2.0-beta.3', 'v0.2.0-rc.4']), '0.2.0-beta.4');
assert.equal(nextVersion('0.2.0', ['v0.2.0', 'v0.2.1']), '0.2.2');
assert.equal(nextVersion('0.2.0', ['0.1.0', '']), '0.2.0');
assert.throws(() => nextVersion('0.2.0-beta', ['v0.2.0-beta']));

console.log('version: all cases passed');
