'use strict';

// Runs the real daemon with the fixture program.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const h = require('./helpers.js');

let dir, file, daemons;

function run(programs, global, extraArgs, env) {
	h.writeConfig(file, { global: Object.assign({ restartDelay: 0.2, killTimeout: 1 }, global || {}), programs: programs });
	const d = new h.Daemon([ '--config', file ].concat(extraArgs || []), env);
	daemons.push(d);
	return d;
}

function runSync(args, env) {
	return spawnSync(process.execPath, [ h.DAEMON ].concat(args), { encoding: 'utf8', env: h.cleanEnv(env), timeout: 10000 });
}

beforeEach(function() {
	dir = h.tmpDir('daemon-test');
	file = path.join(dir, 'c.json');
	daemons = [];
});

afterEach(async function() {
	for (const d of daemons) {
		if (! d.done) {
			d.proc.kill('SIGKILL');
			await d.exited;
		}
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('daemon startup', function() {
	it('requires --config', function() {
		const r = runSync([]);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /config/);
	});

	it('reports an invalid config and starts nothing', function() {
		h.writeConfig(file, { programs: { a: { cmd: [] } } });
		const r = runSync([ '-c', file ]);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /^tr-cli-daemon: Invalid config in .*:\n  programs\.a\.cmd: must be/);
		assert.equal(r.stdout, '');
	});

	it('refuses a config without enabled programs', function() {
		h.writeConfig(file, { programs: { a: { cmd: h.prog('forever'), enabled: false } } });
		const r = runSync([ '-c', file ]);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /no enabled programs/);
	});

	it('takes the config file from TR_CLI_DAEMON_CONFIG', async function() {
		h.writeConfig(file, { programs: { a: { cmd: h.prog('out:hi'), restart: 'never' } } });
		const d = new h.Daemon([], { TR_CLI_DAEMON_CONFIG: file });
		daemons.push(d);
		assert.deepEqual(await d.exited, { code: 0, signal: null });
		assert.deepEqual(d.texts('a'), [ 'hi' ]);
	});

	it('fails if the log file cannot be opened', function() {
		h.writeConfig(file, { programs: { a: { cmd: h.prog('forever') } } });
		const r = runSync([ '-c', file, '--logfile', path.join(dir, 'no', 'such', 'log') ]);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /cannot open log file/);
	});
});

describe('daemon output', function() {
	it('prefixes stdout and stderr lines and pads names', async function() {
		const d = run({ a: { cmd: h.prog('out:one', 'err:two', 'partial:three'), restart: 'never' },
						'long-name-x': { cmd: h.prog('out:four'), restart: 'never' } });
		assert.equal((await d.exited).code, 0);
		assert.deepEqual(d.of('a'), [ [ '|', 'one' ], [ '!', 'two' ], [ '|', 'three' ] ]);
		assert.deepEqual(d.texts('long-name-x'), [ 'four' ]);
		for (const l of d.lines()) {
			assert.match(l, /^.{11} [|!] /);
		}
		assert.match(d.stdout, /@daemon {5}\| .* a exited with code 0, not restarting\n/);
		assert.match(d.stdout, /no programs left to run, exiting\n$/);
	});

	it('logs the last lines before the exit message', async function() {
		const d = run({ a: { cmd: h.prog('out:last', 'exit:3'), restart: 'never' } });
		await d.exited;
		const t = d.texts('@daemon').concat(d.texts('a'));
		const lines = d.lines();
		const iLast = lines.findIndex((l) => / last$/.test(l));
		const iExit = lines.findIndex((l) => /a exited with code 3/.test(l));
		assert.ok((iLast >= 0) && (iExit > iLast), t.join('\n'));
	});

	it('discards stdout or stderr but keeps reading them', async function() {
		const big = Array.from({ length: 2000 }, (x, i) => 'out:' + 'y'.repeat(100) + i);
		const d = run({ a: { cmd: h.prog(...big, 'err:visible', 'exit:0'), restart: 'never', discardStdout: true },
						b: { cmd: h.prog('out:shown', 'err:hidden'), restart: 'never', discardStderr: true } });
		assert.equal((await d.exited).code, 0);
		assert.deepEqual(d.of('a'), [ [ '!', 'visible' ] ]);
		assert.deepEqual(d.of('b'), [ [ '|', 'shown' ] ]);
	});

	it('writes to the log file and reopens it on SIGHUP', async function() {
		const log = path.join(dir, 'out.log');
		const d = run({ a: { cmd: h.prog('out:first', 'sleep:600', 'out:second', 'forever') } }, {}, [ '--logfile', log ]);
		await h.waitUntil(() => (fs.existsSync(log) && / first\n/.test(fs.readFileSync(log, 'utf8'))), 5000, 'first line');
		fs.renameSync(log, log + '.1');
		d.signal('SIGHUP');
		await h.waitUntil(() => (fs.existsSync(log) && / second\n/.test(fs.readFileSync(log, 'utf8'))), 5000, 'second line');
		await d.stop();
		assert.equal(d.stdout, '');
		const old = fs.readFileSync(log + '.1', 'utf8');
		const cur = fs.readFileSync(log, 'utf8');
		assert.match(old, /a +\| .* first\n/);
		assert.doesNotMatch(old, /second/);
		assert.match(cur, /got SIGHUP, reopened log file\n[^]*second\n[^]*shutdown complete\n$/);
	});

	it('takes the log file from TR_CLI_DAEMON_LOGFILE', async function() {
		const log = path.join(dir, 'env.log');
		const d = run({ a: { cmd: h.prog('out:x'), restart: 'never' } }, {}, [], { TR_CLI_DAEMON_LOGFILE: log });
		await d.exited;
		assert.equal(d.stdout, '');
		assert.match(fs.readFileSync(log, 'utf8'), /a +\| .* x\n/);
	});
});

describe('daemon programs', function() {
	it('passes stdin and closes it when asked', async function() {
		const d = run({ a: { cmd: h.prog('stdin'), restart: 'never', stdin: 'foo\nbar\n', closeStdin: true } });
		assert.equal((await d.exited).code, 0);
		assert.deepEqual(d.texts('a'), [ 'in:foo', 'in:bar', 'stdin-eof' ]);
	});

	it('keeps stdin open unless asked to close it', async function() {
		const d = run({ a: { cmd: h.prog('stdin'), stdin: 'foo\n' } });
		await d.waitFor(/ in:foo\n/);
		await new Promise((r) => setTimeout(r, 300));
		assert.ok(! /stdin-eof/.test(d.stdout));
		await d.stop();
	});

	it('closes stdin at once with closeStdin and no text', async function() {
		const d = run({ a: { cmd: h.prog('stdin'), restart: 'never', closeStdin: true } });
		await d.exited;
		assert.deepEqual(d.texts('a'), [ 'stdin-eof' ]);
	});

	it('sets env and cwd', async function() {
		fs.mkdirSync(path.join(dir, 'work'));
		const d = run({ a: { cmd: h.prog('env:SET_ME', 'env:DROP_ME', 'env:KEEP_ME', 'cwd'), restart: 'never',
							 env: { SET_ME: 'v=1', DROP_ME: null }, cwd: 'work' } },
					  {}, [], { DROP_ME: 'x', KEEP_ME: 'y' });
		await d.exited;
		assert.deepEqual(d.texts('a'), [ 'SET_ME=v=1', 'DROP_ME is unset', 'KEEP_ME=y',
										 'cwd=' + fs.realpathSync(path.join(dir, 'work')) ]);
	});

	it('reports a failed spawn', async function() {
		const d = run({ a: { cmd: [ path.join(dir, 'no-such-program') ], restart: 'never' },
						b: { cmd: h.prog('out:x'), restart: 'never', cwd: 'no-such-dir' } });
		assert.equal((await d.exited).code, 0);
		assert.match(d.stdout, /@daemon +! .* a failed to start: .*ENOENT.*, not restarting/);
		assert.match(d.stdout, /@daemon +! .* b failed to start: .*, not restarting/);
	});

	it('skips disabled programs', async function() {
		const d = run({ a: { cmd: h.prog('out:x'), restart: 'never' }, b: { cmd: h.prog('out:y'), enabled: false } });
		await d.exited;
		assert.match(d.stdout, /b is disabled, not starting/);
		assert.deepEqual(d.texts('b'), []);
	});
});

describe('restart policies', function() {
	it('auto restarts after any exit', async function() {
		const d = run({ a: { cmd: h.prog('out:run', 'exit:0'), restart: 'auto' } });
		await d.waitCount(/a +\| .* run$/, 3);
		assert.match(d.stdout, /a exited with code 0, restarting in 0\.2 s/);
		await d.stop();
	});

	it('on-failure restarts only after a failure', async function() {
		const d = run({ ok: { cmd: h.prog('exit:0'), restart: 'on-failure' },
						bad: { cmd: h.prog('out:run', 'exit:2'), restart: 'on-failure' },
						sig: { cmd: h.prog('out:run', 'kill:SIGUSR2'), restart: 'on-failure' } });
		await d.waitCount(/bad +\| .* run$/, 2);
		await d.waitCount(/sig +\| .* run$/, 2);
		assert.match(d.stdout, /ok exited with code 0, not restarting/);
		assert.match(d.stdout, /sig was killed by signal SIGUSR2, restarting in 0\.2 s/);
		assert.equal(d.count(/ok started/), 1);
		await d.stop();
	});

	it('never does not restart', async function() {
		const d = run({ a: { cmd: h.prog('exit:5'), restart: 'never' } });
		assert.equal((await d.exited).code, 0);
		assert.equal(d.count(/a started/), 1);
		assert.match(d.stdout, /a exited with code 5, not restarting/);
	});

	it('uses the global default policy and delay', async function() {
		const d = run({ a: { cmd: h.prog('exit:0') } }, { restart: 'never' });
		await d.exited;
		assert.match(d.stdout, /a exited with code 0, not restarting/);
	});

	it('waits restartDelay between restarts', async function() {
		const d = run({ a: { cmd: h.prog('exit:1'), restartDelay: 0.6 } });
		await d.waitCount(/a started/, 2);
		const times = d.lines().filter((l) => /a (exited|started)/.test(l))
			  .map((l) => Date.parse(l.match(/ (\S+Z) /)[1]));
		// times: started, exited, started
		assert.ok((times[2] - times[1]) >= 550, JSON.stringify(times));
		await d.stop();
	});
});

describe('shutdown', function() {
	it('stops programs with SIGTERM on SIGTERM', async function() {
		const d = run({ a: { cmd: h.prog('term-exit', 'forever') }, b: { cmd: h.prog('exit:1') } });
		await d.waitFor(/a started/);
		await d.waitFor(/b exited/);
		d.signal('SIGTERM');
		assert.deepEqual(await d.exited, { code: 0, signal: null });
		assert.deepEqual(d.texts('a'), [ 'got SIGTERM' ]);
		assert.match(d.stdout, /got SIGTERM, shutting down\n[^]*a stopped \(exited with code 0\)\n[^]*shutdown complete\n$/);
		assert.ok(! /b started[^]*b started[^]*shutdown/.test(d.stdout.split('shutting down')[1]));
	});

	it('stops programs on SIGINT', async function() {
		const d = run({ a: { cmd: h.prog('forever') } });
		await d.waitFor(/a started/);
		d.signal('SIGINT');
		assert.equal((await d.exited).code, 0);
		assert.match(d.stdout, /got SIGINT, shutting down/);
		assert.match(d.stdout, /a stopped \(was killed by signal SIGTERM\)/);
	});

	it('sends SIGKILL after killTimeout', async function() {
		const d = run({ a: { cmd: h.prog('ignore-term', 'forever') } }, { killTimeout: 0.5 });
		await d.waitFor(/a started/);
		await new Promise((r) => setTimeout(r, 200));
		const t0 = Date.now();
		d.signal('SIGTERM');
		assert.equal((await d.exited).code, 0);
		const dt = Date.now() - t0;
		assert.ok((dt >= 400) && (dt < 3000), String(dt));
		assert.match(d.stdout, /a did not stop in 0\.5 s, sending SIGKILL\n[^]*a stopped \(was killed by signal SIGKILL\)/);
	});

	it('sends SIGKILL at once on a second signal', async function() {
		const d = run({ a: { cmd: h.prog('ignore-term', 'forever') } }, { killTimeout: 60 });
		await d.waitFor(/a started/);
		await new Promise((r) => setTimeout(r, 200));
		const t0 = Date.now();
		d.signal('SIGINT');
		await d.waitFor(/shutting down/);
		d.signal('SIGINT');
		assert.equal((await d.exited).code, 0);
		assert.ok((Date.now() - t0) < 3000);
		assert.match(d.stdout, /got SIGINT again, sending SIGKILL to all programs/);
	});

	it('cancels pending restarts', async function() {
		const d = run({ a: { cmd: h.prog('exit:1'), restartDelay: 30 } });
		await d.waitFor(/a exited with code 1, restarting in 30 s/);
		const t0 = Date.now();
		d.signal('SIGTERM');
		assert.equal((await d.exited).code, 0);
		assert.ok((Date.now() - t0) < 3000);
	});

	it('signals the whole process group', async function() {
		const d = run({ a: { cmd: [ '/bin/sh', '-c', 'sleep 60 & echo child=$!; wait' ] } });
		await d.waitFor(/child=\d+/);
		const pid = Number(d.stdout.match(/child=(\d+)/)[1]);
		assert.ok(h.isAlive(pid));
		d.signal('SIGTERM');
		await d.exited;
		await h.waitUntil(() => (! h.isAlive(pid)), 3000, 'grandchild to die');
	});

	it('keeps running programs out of the terminal ^C', async function() {
		// The children are in their own process groups: a SIGINT to the
		// daemon's group must not reach them.
		const d = run({ a: { cmd: h.prog('forever') } });
		await d.waitFor(/a started, pid (\d+)/);
		const pid = Number(d.stdout.match(/a started, pid (\d+)/)[1]);
		const pgid = spawnSync('ps', [ '-o', 'pgid=', '-p', String(pid) ], { encoding: 'utf8' }).stdout.trim();
		assert.equal(pgid, String(pid));
		await d.stop();
	});
});
