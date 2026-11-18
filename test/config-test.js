'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../lib/config.js');

function prog(extra) {
	return Object.assign({ cmd: [ '/bin/true' ] }, extra || {});
}

function cfg(programs, global) {
	const r = { programs: programs || {} };
	if (global !== undefined) {
		r.global = global;
	}
	return r;
}

function problemsOf(raw) {
	return config.problems(raw);
}

function assertProblem(raw, re) {
	const p = problemsOf(raw);
	assert.ok(p.some((x) => re.test(x)), 'expected a problem matching ' + re + ', got ' + JSON.stringify(p));
}

describe('config validation', function() {
	it('accepts a minimal config', function() {
		assert.deepEqual(problemsOf({ programs: {} }), []);
		assert.deepEqual(problemsOf(cfg({ a: prog() })), []);
	});

	it('accepts a config with every key set', function() {
		const raw = cfg({
			something: {
				cmd: [ '/foo/something', '--very' ],
				enabled: false,
				restart: 'on-failure',
				restartDelay: 0.5,
				cwd: 'rel/dir',
				env: { LANG: 'C', GONE: null },
				stdin: 'foo\nbar\n',
				closeStdin: true,
				discardStdout: true,
				discardStderr: false
			}
		}, { restart: 'never', restartDelay: 0, killTimeout: 2.5 });
		assert.deepEqual(problemsOf(raw), []);
	});

	it('rejects non-objects at the top level', function() {
		for (const x of [ null, [], 'x', 1, true ]) {
			assertProblem(x, /^config: must be a JSON object$/);
		}
	});

	it('requires programs', function() {
		assertProblem({}, /^programs: missing$/);
		assertProblem({ programs: [] }, /^programs: must be an object$/);
	});

	it('rejects unknown keys everywhere', function() {
		assertProblem({ programs: {}, config: {} }, /^config: unknown key "config"$/);
		assertProblem(cfg({}, { restartdelay: 1 }), /^global: unknown key "restartdelay"$/);
		assertProblem(cfg({ a: prog({ closestdin: true }) }), /^programs\.a: unknown key "closestdin"$/);
	});

	it('checks global values', function() {
		assertProblem(cfg({}, []), /^global: must be an object$/);
		assertProblem(cfg({}, { restart: 'always' }), /^global\.restart: must be one of/);
		assertProblem(cfg({}, { restartDelay: -1 }), /^global\.restartDelay:/);
		assertProblem(cfg({}, { restartDelay: '10' }), /^global\.restartDelay:/);
		assertProblem(cfg({}, { restartDelay: config.MAX_SECONDS + 1 }), /^global\.restartDelay:/);
		assertProblem(cfg({}, { killTimeout: 0 }), /^global\.killTimeout:/);
		assertProblem(cfg({}, { killTimeout: Infinity }), /^global\.killTimeout:/);
	});

	it('checks program names', function() {
		for (const n of [ 'a', 'A9', 'x.y_z-1', '0', 'a'.repeat(64) ]) {
			assert.deepEqual(problemsOf(cfg({ [n]: prog() })), [], n);
		}
		for (const n of [ '', '-a', '.a', '_a', '@daemon', 'a b', 'a/b', 'a'.repeat(65), 'ä' ]) {
			assertProblem(cfg({ [n]: prog() }), /invalid program name/);
		}
	});

	it('checks cmd', function() {
		assertProblem(cfg({ a: {} }), /^programs\.a\.cmd: missing$/);
		for (const c of [ [], [ '' ], 'x', [ 1 ], [ 'a', null ], [ 'a\0b' ] ]) {
			assertProblem(cfg({ a: { cmd: c } }), /^programs\.a\.cmd: must be/);
		}
		assert.deepEqual(problemsOf(cfg({ a: { cmd: [ 'x', '' ] } })), []);
	});

	it('checks program values', function() {
		assertProblem(cfg({ a: 'x' }), /^programs\.a: must be an object$/);
		assertProblem(cfg({ a: prog({ enabled: 1 }) }), /^programs\.a\.enabled: must be true or false$/);
		assertProblem(cfg({ a: prog({ closeStdin: 'yes' }) }), /^programs\.a\.closeStdin:/);
		assertProblem(cfg({ a: prog({ discardStdout: null }) }), /^programs\.a\.discardStdout:/);
		assertProblem(cfg({ a: prog({ discardStderr: 0 }) }), /^programs\.a\.discardStderr:/);
		assertProblem(cfg({ a: prog({ restart: 'on_failure' }) }), /^programs\.a\.restart:/);
		assertProblem(cfg({ a: prog({ restartDelay: NaN }) }), /^programs\.a\.restartDelay:/);
		assertProblem(cfg({ a: prog({ cwd: '' }) }), /^programs\.a\.cwd:/);
		assertProblem(cfg({ a: prog({ cwd: 1 }) }), /^programs\.a\.cwd:/);
		assertProblem(cfg({ a: prog({ stdin: null }) }), /^programs\.a\.stdin:/);
	});

	it('checks env', function() {
		assertProblem(cfg({ a: prog({ env: [] }) }), /^programs\.a\.env: must be an object$/);
		assertProblem(cfg({ a: prog({ env: { '': 'x' } }) }), /invalid variable name ""/);
		assertProblem(cfg({ a: prog({ env: { 'A=B': 'x' } }) }), /invalid variable name "A=B"/);
		assertProblem(cfg({ a: prog({ env: { A: 1 } }) }), /^programs\.a\.env\.A: must be a string or null$/);
		assert.deepEqual(problemsOf(cfg({ a: prog({ env: { A: '', B: null } }) })), []);
	});

	it('reports all problems at once', function() {
		const p = problemsOf(cfg({ a: { cmd: [], restart: 'x' }, '-b': prog() }, { killTimeout: -1 }));
		assert.equal(p.length, 4);
	});

	it('validate() throws a ConfigError listing the problems', function() {
		assert.throws(function() {
			config.validate({ programs: { a: {} } }, 'x.json');
		}, function(e) {
			return ((e instanceof config.ConfigError) &&
					/^Invalid config in x\.json:\n  programs\.a\.cmd: missing$/.test(e.message) &&
					(e.problems.length === 1));
		});
	});
});

describe('config normalization', function() {
	it('applies built-in defaults', function() {
		const n = config.normalize(cfg({ a: prog() }), '/etc');
		assert.deepEqual(n.global, { restart: 'auto', restartDelay: 10, killTimeout: 10 });
		assert.deepEqual(n.programs, [ {
			name: 'a',
			cmd: [ '/bin/true' ],
			enabled: true,
			restart: 'auto',
			restartDelay: 10,
			cwd: null,
			env: {},
			stdin: '',
			closeStdin: false,
			discardStdout: false,
			discardStderr: false
		} ]);
	});

	it('applies global defaults to programs', function() {
		const n = config.normalize(cfg({ a: prog(), b: prog({ restart: 'auto', restartDelay: 3 }) },
									   { restart: 'never', restartDelay: 1, killTimeout: 4 }), '/');
		assert.equal(n.global.killTimeout, 4);
		assert.equal(n.programs[0].restart, 'never');
		assert.equal(n.programs[0].restartDelay, 1);
		assert.equal(n.programs[1].restart, 'auto');
		assert.equal(n.programs[1].restartDelay, 3);
	});

	it('keeps config order', function() {
		const n = config.normalize(cfg({ z: prog(), a: prog(), m: prog() }), '/');
		assert.deepEqual(n.programs.map((p) => p.name), [ 'z', 'a', 'm' ]);
	});

	it('resolves cwd against the config directory', function() {
		const n = config.normalize(cfg({ a: prog({ cwd: 'sub/dir' }), b: prog({ cwd: '/abs' }) }), '/etc/x');
		assert.equal(n.programs[0].cwd, '/etc/x/sub/dir');
		assert.equal(n.programs[1].cwd, '/abs');
	});

	it('copies cmd and env', function() {
		const raw = cfg({ a: prog({ env: { A: 'b' } }) });
		const n = config.normalize(raw, '/');
		n.programs[0].cmd.push('x');
		n.programs[0].env.B = 'c';
		assert.deepEqual(raw.programs.a.cmd, [ '/bin/true' ]);
		assert.deepEqual(raw.programs.a.env, { A: 'b' });
	});
});

describe('config files', function() {
	let dir;
	beforeEach(function() {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-cli-daemon-test-'));
	});
	afterEach(function() {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('round-trips through save and load', function() {
		const file = path.join(dir, 'c.json');
		const raw = cfg({ a: prog({ cwd: 'w' }) }, { killTimeout: 3 });
		config.save(file, raw);
		assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(raw, null, 2) + '\n');
		const l = config.load(file);
		assert.deepEqual(l.raw, raw);
		assert.equal(l.config.programs[0].cwd, path.join(dir, 'w'));
		assert.equal(l.config.global.killTimeout, 3);
	});

	it('leaves no temp files behind', function() {
		const file = path.join(dir, 'c.json');
		config.save(file, cfg());
		config.save(file, cfg({ a: prog() }));
		assert.deepEqual(fs.readdirSync(dir), [ 'c.json' ]);
	});

	it('keeps the mode of an existing file', function() {
		const file = path.join(dir, 'c.json');
		fs.writeFileSync(file, '{}', { mode: 0o600 });
		fs.chmodSync(file, 0o600);
		config.save(file, cfg());
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	});

	it('refuses to save an invalid config and keeps the old file', function() {
		const file = path.join(dir, 'c.json');
		config.save(file, cfg());
		assert.throws(() => config.save(file, { programs: { a: {} } }), config.ConfigError);
		assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), cfg());
		assert.deepEqual(fs.readdirSync(dir), [ 'c.json' ]);
	});

	it('exclusive save does not overwrite', function() {
		const file = path.join(dir, 'c.json');
		config.save(file, cfg(), { exclusive: true });
		assert.throws(() => config.save(file, cfg({ a: prog() }), { exclusive: true }), /already exists/);
		assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), cfg());
		assert.deepEqual(fs.readdirSync(dir), [ 'c.json' ]);
	});

	it('reports unreadable and malformed files', function() {
		assert.throws(() => config.load(path.join(dir, 'nope.json')), /^ConfigError: Cannot read config file/);
		const file = path.join(dir, 'bad.json');
		fs.writeFileSync(file, '{ "programs": { } // no comments\n}');
		assert.throws(() => config.load(file), /is not valid JSON/);
		fs.writeFileSync(file, '{ "programs": { "a": {} } }');
		assert.throws(() => config.load(file), /programs\.a\.cmd: missing/);
	});
});
