'use strict';

// Sanity checks for the package layout: the declared executables exist,
// are executable and start with a node shebang.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');

describe('package', function() {
	it('declares the three executables', function() {
		assert.deepEqual(Object.keys(pkg.bin).sort(),
						 [ 'tr-cli-daemon', 'tr-cli-daemon-config', 'tr-cli-daemon-ctl' ]);
	});
	it('has no library entry point', function() {
		assert.equal(pkg.main, undefined);
		assert.equal(pkg.exports, undefined);
	});
	for (const name of Object.keys(pkg.bin)) {
		it(name + ' is an executable node script', function() {
			const file = path.join(ROOT, pkg.bin[name]);
			const st = fs.statSync(file);
			assert.ok(st.isFile());
			assert.ok((st.mode & 0o111) !== 0);
			assert.match(fs.readFileSync(file, 'utf8'), /^#!\/usr\/bin\/env node\n/);
		});
	}
	it('ships identical licence files', function() {
		assert.equal(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8'),
					 fs.readFileSync(path.join(ROOT, 'MIT-RINNE'), 'utf8'));
	});
});
