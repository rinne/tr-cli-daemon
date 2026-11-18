'use strict';

// Runs the real tr-cli-daemon-config executable against temp dirs.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TOOL = path.join(__dirname, '..', 'bin', 'tr-cli-daemon-config.js');

let dir, file;

function tool(args, env) {
	const e = Object.assign({}, process.env, env || {});
	delete e.TR_CLI_DAEMON_CONFIG;
	Object.assign(e, env || {});
	const r = spawnSync(process.execPath, [ TOOL ].concat(args), { encoding: 'utf8', env: e });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function ok(args, env) {
	const r = tool([ '-c', file ].concat(args), env);
	assert.equal(r.status, 0, 'expected success for ' + JSON.stringify(args) + ', stderr: ' + r.stderr);
	return r;
}

function bad(args, re) {
	const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
	const r = tool([ '-c', file ].concat(args));
	assert.equal(r.status, 1, 'expected failure for ' + JSON.stringify(args));
	if (re) {
		assert.match(r.stderr, re);
	}
	const after = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
	assert.equal(after, before, 'config must be unchanged after a failure');
	return r;
}

function read() {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function programs() {
	return read().programs;
}

beforeEach(function() {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-cli-daemon-config-test-'));
	file = path.join(dir, 'd.json');
});

afterEach(function() {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('global options and help', function() {
	it('prints help with the command list', function() {
		const r = tool([ '--help' ]);
		assert.equal(r.status, 0);
		assert.match(r.stdout, /Commands:\n  create-config/);
		assert.equal(tool([ 'help' ]).stdout, r.stdout);
	});

	it('prints help for a command without needing --config', function() {
		const r = tool([ 'help', 'add-program' ]);
		assert.equal(r.status, 0);
		assert.match(r.stdout, /add-program \[<opt> \.\.\.\] <name> <cmd>/);
		assert.equal(tool([ 'add-program', '--help' ]).stdout, r.stdout);
	});

	it('rejects unknown commands', function() {
		const r = tool([ '-c', file, 'frobnicate' ]);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /unknown command "frobnicate"\nCommands:/);
		assert.equal(tool([ 'help', 'frobnicate' ]).status, 1);
	});

	it('requires a command', function() {
		assert.equal(tool([ '-c', file ]).status, 1);
	});

	it('requires --config', function() {
		const r = tool([ 'create-config' ]);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /no config file given/);
	});

	it('takes the config file from TR_CLI_DAEMON_CONFIG', function() {
		const r = tool([ 'create-config' ], { TR_CLI_DAEMON_CONFIG: file });
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(read(), { global: {}, programs: {} });
	});
});

describe('create-config', function() {
	it('creates an empty config and refuses to overwrite it', function() {
		ok([ 'create-config' ]);
		assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "global": {},\n  "programs": {}\n}\n');
		ok([ 'add-program', 'a', '/bin/true' ]);
		bad([ 'create-config' ], /already exists/);
		ok([ 'create-config', '--force' ]);
		assert.deepEqual(read(), { global: {}, programs: {} });
	});

	it('takes no parameters', function() {
		bad([ 'create-config', 'x' ]);
	});
});

describe('add-program', function() {
	beforeEach(function() {
		ok([ 'create-config' ]);
	});

	it('adds a minimal program', function() {
		ok([ 'add-program', 'a', '/bin/echo', 'hi' ]);
		assert.deepEqual(programs(), { a: { cmd: [ '/bin/echo', 'hi' ] } });
	});

	it('leaves the program options to the program', function() {
		ok([ 'add-program', '--restart=never', 'a', '/bin/prog', '--restart=auto', '-c', 'x', '--', '-h' ]);
		assert.deepEqual(programs().a,
						 { cmd: [ '/bin/prog', '--restart=auto', '-c', 'x', '--', '-h' ], restart: 'never' });
	});

	it('accepts -- before the parameters', function() {
		ok([ 'add-program', '--', 'a', '-weird-cmd' ]);
		assert.deepEqual(programs().a.cmd, [ '-weird-cmd' ]);
	});

	it('sets every option, in canonical key order', function() {
		const sf = path.join(dir, 'in.txt');
		fs.writeFileSync(sf, 'from\nfile\n');
		ok([ 'add-program', '--discard-stderr', '--discard-stdout', '--close-stdin', '--stdin-file', sf,
			 '--unset-env=GONE', '--env=A=b=c', '--env', 'E=', '--cwd=work', '--restart-delay=0.5',
			 '--restart=on-failure', '--disabled', 'a', '/bin/x' ]);
		const a = programs().a;
		assert.deepEqual(Object.keys(a), [ 'cmd', 'enabled', 'restart', 'restartDelay', 'cwd', 'env',
										   'stdin', 'closeStdin', 'discardStdout', 'discardStderr' ]);
		assert.deepEqual(a, {
			cmd: [ '/bin/x' ], enabled: false, restart: 'on-failure', restartDelay: 0.5, cwd: 'work',
			env: { A: 'b=c', E: '', GONE: null }, stdin: 'from\nfile\n', closeStdin: true,
			discardStdout: true, discardStderr: true
		});
	});

	it('takes stdin text from the command line', function() {
		ok([ 'add-program', '--stdin', 'foo\nbar\n', 'a', '/bin/cat' ]);
		assert.equal(programs().a.stdin, 'foo\nbar\n');
	});

	it('rejects bad input', function() {
		ok([ 'add-program', 'a', '/bin/true' ]);
		bad([ 'add-program', 'a', '/bin/true' ], /program a already exists/);
		bad([ 'add-program', '-x', '/bin/true' ]);
		bad([ 'add-program', '@x', '/bin/true' ], /invalid program name "@x"/);
		bad([ 'add-program', 'b' ], /Too few/);
		bad([ 'add-program', 'b', '' ], /cmd: must be/);
		bad([ 'add-program', '--restart=always', 'b', '/bin/true' ]);
		bad([ 'add-program', '--restart-delay=-1', 'b', '/bin/true' ]);
		bad([ 'add-program', '--restart-delay=1e3', 'b', '/bin/true' ]);
		bad([ 'add-program', '--env=NOVALUE', 'b', '/bin/true' ]);
		bad([ 'add-program', '--env=A=1', '--unset-env=A', 'b', '/bin/true' ], /both --env and --unset-env/);
		bad([ 'add-program', '--stdin=x', '--stdin-file', file, 'b', '/bin/true' ], /conflicts/);
		bad([ 'add-program', '--stdin-file', path.join(dir, 'nope'), 'b', '/bin/true' ]);
		bad([ 'add-program', '--remove-env=A', 'b', '/bin/true' ]);
	});

	it('needs an existing config', function() {
		fs.rmSync(file);
		bad([ 'add-program', 'a', '/bin/true' ], /create it with create-config/);
	});

	it('refuses to edit an invalid config', function() {
		fs.writeFileSync(file, '{"programs": {"a": {"cmd": []}}}');
		bad([ 'add-program', 'b', '/bin/true' ], /programs\.a\.cmd: must be/);
	});
});

describe('modify-program', function() {
	beforeEach(function() {
		ok([ 'create-config' ]);
		ok([ 'add-program', 'first', '/bin/one' ]);
		ok([ 'add-program', '--env=A=1', '--env=B=2', '--close-stdin', '--stdin=x', '--restart=never',
			 'mid', '/bin/two', 'arg' ]);
		ok([ 'add-program', 'last', '/bin/three' ]);
	});

	it('replaces the command line', function() {
		ok([ 'modify-program', 'mid', '/bin/new', '--flag' ]);
		assert.deepEqual(programs().mid.cmd, [ '/bin/new', '--flag' ]);
	});

	it('toggles booleans and drops default values', function() {
		ok([ 'modify-program', '--disable', '--discard-stdout', '--no-close-stdin', 'mid' ]);
		let m = programs().mid;
		assert.equal(m.enabled, false);
		assert.equal(m.discardStdout, true);
		assert.equal(Object.hasOwn(m, 'closeStdin'), false);
		ok([ 'modify-program', '--enable', '--no-discard-stdout', '--discard-stderr', 'mid' ]);
		m = programs().mid;
		assert.equal(Object.hasOwn(m, 'enabled'), false);
		assert.equal(Object.hasOwn(m, 'discardStdout'), false);
		assert.equal(m.discardStderr, true);
		ok([ 'modify-program', '--no-discard-stderr', 'mid' ]);
		assert.equal(Object.hasOwn(programs().mid, 'discardStderr'), false);
	});

	it('edits env entries', function() {
		ok([ 'modify-program', '--env=A=9', '--unset-env=C', '--remove-env=B', 'mid' ]);
		assert.deepEqual(programs().mid.env, { A: '9', C: null });
		ok([ 'modify-program', '--remove-env=A', '--remove-env=C', 'mid' ]);
		assert.equal(Object.hasOwn(programs().mid, 'env'), false);
		bad([ 'modify-program', '--remove-env=A', 'mid' ], /not in env/);
	});

	it('resets keys to their defaults', function() {
		ok([ 'modify-program', '--reset=restart', '--reset', 'env', '--reset=stdin', 'mid' ]);
		assert.deepEqual(programs().mid, { cmd: [ '/bin/two', 'arg' ], closeStdin: true });
		bad([ 'modify-program', '--reset=cmd', 'mid' ], /unknown key "cmd"/);
		bad([ 'modify-program', '--reset=restart', '--restart=auto', 'mid' ], /conflicts/);
	});

	it('sets values and keeps canonical key order', function() {
		ok([ 'modify-program', '--restart-delay=3', '--cwd=/tmp', '--restart=auto', 'mid' ]);
		const m = programs().mid;
		assert.deepEqual(Object.keys(m), [ 'cmd', 'restart', 'restartDelay', 'cwd', 'env', 'stdin', 'closeStdin' ]);
		assert.equal(m.restart, 'auto');
		assert.equal(m.restartDelay, 3);
		assert.equal(m.cwd, '/tmp');
	});

	it('renames in place', function() {
		ok([ 'modify-program', '--rename=middle', 'mid' ]);
		assert.deepEqual(Object.keys(programs()), [ 'first', 'middle', 'last' ]);
		bad([ 'modify-program', '--rename=first', 'middle' ], /already exists/);
		bad([ 'modify-program', '--rename=b@d', 'middle' ], /invalid program name/);
	});

	it('rejects conflicting and empty changes', function() {
		bad([ 'modify-program', '--enable', '--disable', 'mid' ], /conflicts/);
		bad([ 'modify-program', '--close-stdin', '--no-close-stdin', 'mid' ], /conflicts/);
		bad([ 'modify-program', 'mid' ], /nothing to change/);
		bad([ 'modify-program', '--restart=never', 'mid' ], /nothing to change/);
		bad([ 'modify-program', '--disable', 'nope' ], /no such program: nope/);
	});
});

describe('remove-program', function() {
	it('removes a program', function() {
		ok([ 'create-config' ]);
		ok([ 'add-program', 'a', '/bin/true' ]);
		ok([ 'add-program', 'b', '/bin/true' ]);
		ok([ 'remove-program', 'a' ]);
		assert.deepEqual(Object.keys(programs()), [ 'b' ]);
		bad([ 'remove-program', 'a' ], /no such program: a/);
		bad([ 'remove-program' ]);
		bad([ 'remove-program', 'b', 'c' ]);
	});
});

describe('modify-global', function() {
	beforeEach(function() {
		ok([ 'create-config' ]);
	});

	it('sets and resets global defaults', function() {
		ok([ 'modify-global', '--kill-timeout=2.5', '--restart=on-failure', '--restart-delay=0' ]);
		assert.deepEqual(read().global, { restart: 'on-failure', restartDelay: 0, killTimeout: 2.5 });
		assert.deepEqual(Object.keys(read()), [ 'global', 'programs' ]);
		ok([ 'modify-global', '--reset=restart', '--reset=killTimeout' ]);
		assert.deepEqual(read().global, { restartDelay: 0 });
	});

	it('adds global to a config without it', function() {
		fs.writeFileSync(file, '{"programs": {}}');
		ok([ 'modify-global', '--restart=never' ]);
		assert.deepEqual(Object.keys(read()), [ 'global', 'programs' ]);
	});

	it('rejects bad input', function() {
		bad([ 'modify-global' ], /nothing to change/);
		bad([ 'modify-global', '--kill-timeout=0' ]);
		bad([ 'modify-global', '--reset=cwd' ], /unknown key "cwd"/);
		bad([ 'modify-global', '--reset=restart', '--restart=never' ], /conflicts/);
	});
});

describe('show', function() {
	it('prints the config or one program', function() {
		ok([ 'create-config' ]);
		ok([ 'add-program', 'a', '/bin/true' ]);
		assert.equal(ok([ 'show' ]).stdout, fs.readFileSync(file, 'utf8'));
		assert.equal(ok([ 'show', 'a' ]).stdout, '{\n  "cmd": [\n    "/bin/true"\n  ]\n}\n');
		bad([ 'show', 'b' ], /no such program: b/);
	});

	it('reports an invalid config', function() {
		fs.writeFileSync(file, '{"programs": 1}');
		bad([ 'show' ], /programs: must be an object/);
	});
});
