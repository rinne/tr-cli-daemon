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

describe('documentation', function() {
	const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
	const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

	it('README documents every config key', function() {
		const config = require('../lib/config.js');
		for (const k of config.PROGRAM_KEYS.concat(config.GLOBAL_KEYS)) {
			assert.ok(readme.includes('`' + k + '`'), k);
		}
	});

	it('README documents every command and option of the tools', function() {
		for (const spec of [ require('../lib/config-tool.js').SPEC, require('../lib/ctl.js').SPEC ]) {
			for (const [ name, c ] of Object.entries(spec.commands)) {
				assert.ok(readme.includes('`' + name), spec.name + ' ' + name);
				for (const o of (c.opts || [])) {
					assert.ok(readme.includes('--' + o.longName), spec.name + ' ' + name + ' --' + o.longName);
				}
			}
			for (const o of spec.globalOpts) {
				assert.ok(readme.includes('--' + o.longName), spec.name + ' --' + o.longName);
			}
		}
	});

	it('README documents every environment variable', function() {
		const src = [ 'daemon.js', 'config-tool.js', 'ctl.js' ]
			  .map((f) => fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8')).join('\n');
		const vars = new Set(src.match(/TR_CLI_DAEMON_[A-Z_]+/g));
		assert.ok(vars.size >= 4);
		for (const v of vars) {
			assert.ok(readme.includes('`' + v + '`'), v);
		}
	});

	it('README states the Node.js version required by engines', function() {
		const m = pkg.engines.node.match(/^>=(\d+)\.0\.0$/);
		assert.ok(m, pkg.engines.node);
		assert.ok(readme.includes('Node.js ' + m[1] + ' or newer'));
	});

	it('CHANGELOG has an entry for the package version', function() {
		assert.ok(changelog.includes('\n' + pkg.version + '\n' + '-'.repeat(pkg.version.length) + '\n'));
	});
});
