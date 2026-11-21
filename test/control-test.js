'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const h = require('./helpers.js');
const control = require('../lib/control.js');

let dir, file, sock, daemons, servers;

function cfg(programs, global) {
	return { global: Object.assign({ restartDelay: 0.2, killTimeout: 1 }, global || {}), programs: programs };
}

function start(programs, global, env) {
	h.writeConfig(file, cfg(programs, global));
	const d = new h.Daemon([ '-c', file, '-s', sock ], env);
	daemons.push(d);
	return d;
}

async function ready(d) {
	await d.waitFor(/starting tr-cli-daemon/);
	return d;
}

function ctl(args, env) {
	const r = spawnSync(process.execPath, [ h.CTL ].concat(args),
						{ encoding: 'utf8', env: h.cleanEnv(env), timeout: 15000 });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function ctlAsync(args) {
	return new Promise(function(resolve) {
		const p = spawn(process.execPath, [ h.CTL ].concat(args), { env: h.cleanEnv() });
		let stdout = '', stderr = '';
		p.stdout.on('data', (d) => { stdout += d; });
		p.stderr.on('data', (d) => { stderr += d; });
		p.on('close', (code) => resolve({ status: code, stdout: stdout, stderr: stderr }));
	});
}

function ok(args) {
	const r = ctl([ '-s', sock ].concat(args));
	assert.equal(r.status, 0, 'ctl ' + args.join(' ') + ' failed: ' + r.stderr);
	return r;
}

function status() {
	const r = ok([ '--json', 'status' ]);
	const j = JSON.parse(r.stdout);
	assert.equal(j.ok, true);
	return new Map(j.result.map((p) => [ p.name, p ]));
}

function pidOf(d, name) {
	const m = Array.from(d.stdout.matchAll(new RegExp(' ' + name + ' started, pid (\\d+)', 'g')));
	return Number(m[m.length - 1][1]);
}

beforeEach(function() {
	dir = h.tmpDir('control-test');
	file = path.join(dir, 'c.json');
	sock = path.join(dir, 'ctl.sock');
	daemons = [];
	servers = [];
});

afterEach(async function() {
	for (const d of daemons) {
		if (! d.done) {
			d.proc.kill('SIGKILL');
			await d.exited;
		}
	}
	for (const s of servers) {
		s.close();
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('control protocol', function() {
	it('parses requests strictly', function() {
		assert.deepEqual(control.parseRequest('{"command":"status"}'), { command: 'status', args: [] });
		assert.deepEqual(control.parseRequest('{"command":"restart","args":["a"]}'), { command: 'restart', args: [ 'a' ] });
		for (const [ line, re ] of [ [ '{x', /not valid JSON/ ], [ '[]', /must be a JSON object/ ], [ 'null', /must be a JSON object/ ],
									 [ '{}', /no command/ ], [ '{"command":""}', /no command/ ],
									 [ '{"command":"x","args":"a"}', /array of strings/ ],
									 [ '{"command":"x","args":[1]}', /array of strings/ ] ]) {
			assert.throws(() => control.parseRequest(line), re, line);
		}
	});

	it('answers requests, one at a time', async function() {
		let release;
		const server = new control.Server(sock, async function(req) {
			if (req.command === 'slow') {
				await new Promise((r) => { release = r; });
				return 'slow done';
			}
			if (req.command === 'fail') {
				throw new Error('it failed');
			}
			return { echo: req.args };
		});
		servers.push(server);
		await server.listen();
		assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
		assert.deepEqual(await control.request(sock, 'x', [ 'a', 'b' ], 2000), { ok: true, result: { echo: [ 'a', 'b' ] } });
		assert.deepEqual(await control.request(sock, 'fail', [], 2000), { ok: false, error: 'it failed' });
		const slow = control.request(sock, 'slow', [], 2000);
		await h.waitUntil(() => release, 2000, 'slow command');
		assert.deepEqual(await control.request(sock, 'x', [], 2000), { ok: false, error: 'busy' });
		release();
		assert.deepEqual(await slow, { ok: true, result: 'slow done' });
		server.refuse();
		assert.deepEqual(await control.request(sock, 'x', [], 2000), { ok: false, error: 'busy' });
		server.close();
		assert.equal(fs.existsSync(sock), false);
	});

	it('calls after() once the reply is written', async function() {
		let afterCalled = false;
		const server = new control.Server(sock, async () => ({ result: 42, after: () => { afterCalled = true; } }));
		servers.push(server);
		await server.listen();
		assert.deepEqual(await control.request(sock, 'x', [], 2000), { ok: true, result: 42 });
		await h.waitUntil(() => afterCalled, 2000, 'after()');
	});

	it('lets a command run longer than the request timeout', async function() {
		let afterCalled = false;
		const server = new control.Server(sock, async function() {
			await new Promise((r) => setTimeout(r, 600));
			return { result: 'slow', after: () => { afterCalled = true; } };
		}, 200);
		servers.push(server);
		await server.listen();
		assert.deepEqual(await control.request(sock, 'quit', [], 3000), { ok: true, result: 'slow' });
		await h.waitUntil(() => afterCalled, 2000, 'after()');
	});

	it('times out a request that is never completed', async function() {
		const server = new control.Server(sock, async () => 'never', 200);
		servers.push(server);
		await server.listen();
		const reply = await new Promise(function(resolve) {
			const s = net.connect(sock);
			let buf = '';
			s.setEncoding('utf8');
			s.on('data', (d) => { buf += d; });
			s.on('close', () => resolve(buf));
			s.on('error', () => {});
			s.on('connect', () => s.write('{"command":'));
		});
		assert.equal(reply, '{"ok":false,"error":"request timed out"}\n');
	});

	it('rejects bad and oversized requests', async function() {
		const server = new control.Server(sock, async () => 'never');
		servers.push(server);
		await server.listen();
		async function raw(data, endIt) {
			return new Promise(function(resolve) {
				const s = net.connect(sock);
				let buf = '';
				s.setEncoding('utf8');
				s.on('data', (d) => { buf += d; });
				s.on('close', () => resolve(buf));
				s.on('error', () => {});
				s.on('connect', function() {
					if (endIt) {
						s.end(data);
					} else {
						s.write(data);
					}
				});
			});
		}
		assert.equal(await raw('nope\n'), '{"ok":false,"error":"request is not valid JSON"}\n');
		assert.equal(await raw('{"command":"x"', true), '{"ok":false,"error":"incomplete request"}\n');
		assert.equal(await raw('x'.repeat(control.MAX_REQUEST + 2)), '{"ok":false,"error":"request too large"}\n');
	});

	it('refuses a path that is not a socket', async function() {
		fs.writeFileSync(sock, 'x');
		await assert.rejects(control.preparePath(sock), /exists and is not a socket/);
	});

	it('removes a stale socket', async function() {
		// A listener killed without cleanup leaves the socket file behind.
		const p = spawn(process.execPath, [ '-e', 'require("net").createServer().listen(process.argv[1], () => console.log("up"))', sock ]);
		await new Promise((r) => p.stdout.once('data', r));
		p.kill('SIGKILL');
		await new Promise((r) => p.on('close', r));
		assert.ok(fs.lstatSync(sock).isSocket());
		await control.preparePath(sock);
		assert.equal(fs.existsSync(sock), false);
	});

	it('refuses a socket another process listens on', async function() {
		const s = net.createServer();
		await new Promise((r) => s.listen(sock, r));
		try {
			await assert.rejects(control.preparePath(sock), /another daemon is listening/);
		} finally {
			s.close();
		}
	});
});

describe('daemon with a control socket', function() {
	it('creates the socket with mode 0600 and removes it on exit', async function() {
		const d = await ready(start({ a: { cmd: h.prog('forever') } }));
		assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
		assert.match(d.stdout, /, control socket .*ctl\.sock\n/);
		await d.stop();
		assert.equal(fs.existsSync(sock), false);
	});

	it('takes the socket path from TR_CLI_DAEMON_CONTROL_SOCKET', async function() {
		h.writeConfig(file, cfg({ a: { cmd: h.prog('forever') } }));
		const d = new h.Daemon([ '-c', file ], { TR_CLI_DAEMON_CONTROL_SOCKET: sock });
		daemons.push(d);
		await ready(d);
		const r = ctl([ 'status' ], { TR_CLI_DAEMON_CONTROL_SOCKET: sock });
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /^NAME +STATE +PID +SINCE +RESTARTS +LAST EXIT\na +running +\d+ /);
	});

	it('opens no socket without the option', async function() {
		h.writeConfig(file, cfg({ a: { cmd: h.prog('forever') } }));
		const d = new h.Daemon([ '-c', file ]);
		daemons.push(d);
		await d.waitFor(/a started/);
		assert.deepEqual(fs.readdirSync(dir), [ 'c.json' ]);
		assert.doesNotMatch(d.stdout, /control socket/);
	});

	it('refuses to start when another daemon owns the socket', async function() {
		await ready(start({ a: { cmd: h.prog('forever') } }));
		const r = spawnSync(process.execPath, [ h.DAEMON, '-c', file, '-s', sock ], { encoding: 'utf8', env: h.cleanEnv(), timeout: 10000 });
		assert.equal(r.status, 1);
		assert.match(r.stderr, /another daemon is listening on control socket/);
		assert.ok(fs.lstatSync(sock).isSocket());
		assert.equal(ok([ 'status' ]).status, 0);
	});

	it('starts with no enabled programs and waits for commands', async function() {
		const d = start({ a: { cmd: h.prog('out:hello', 'forever'), enabled: false } });
		await d.waitFor(/no programs running, waiting for control commands/);
		assert.match(d.stdout, /@daemon ! .* no enabled programs in the config/);
		h.writeConfig(file, cfg({ a: { cmd: h.prog('out:hello', 'forever') } }));
		assert.equal(ok([ 'restart' ]).stdout, 'a started\n');
		await d.waitFor(/a +\| .* hello/);
	});

	it('stays up when all programs have ended', async function() {
		const d = start({ a: { cmd: h.prog('exit:0'), restart: 'never' } });
		await d.waitFor(/no programs running, waiting for control commands/);
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(d.done, false);
		const a = status().get('a');
		assert.equal(a.state, 'stopped');
		assert.deepEqual(a.lastExit, { code: 0, signal: null });
	});
});

describe('tr-cli-daemon-ctl status', function() {
	it('reports every program', async function() {
		const d = start({ run: { cmd: h.prog('forever') },
						  fail: { cmd: h.prog('exit:3'), restartDelay: 30 },
						  off: { cmd: h.prog('forever'), enabled: false } });
		await d.waitFor(/fail exited with code 3/);
		const s = status();
		assert.deepEqual(Array.from(s.keys()), [ 'run', 'fail', 'off' ]);
		assert.equal(s.get('run').state, 'running');
		assert.equal(s.get('run').pid, pidOf(d, 'run'));
		assert.equal(s.get('run').lastExit, null);
		assert.equal(s.get('fail').state, 'waiting');
		assert.equal(s.get('fail').pid, null);
		assert.deepEqual(s.get('fail').lastExit, { code: 3, signal: null });
		assert.equal(s.get('off').state, 'stopped');
		assert.equal(s.get('off').enabled, false);
		assert.match(s.get('run').since, /^\d{4}-\d\d-\d\dT.*Z$/);
		const text = ok([ 'status' ]).stdout;
		assert.match(text, /\nfail +waiting +- +\S+ +0 +code 3\n/);
		assert.match(text, /\noff \(disabled\) +stopped +- /);
	});

	it('counts restarts', async function() {
		const d = start({ a: { cmd: h.prog('exit:1'), restartDelay: 0.1 } });
		await d.waitCount(/a started/, 3);
		assert.ok(status().get('a').restarts >= 2);
	});
});

describe('tr-cli-daemon-ctl restart', function() {
	it('restarts everything with the new config', async function() {
		const d = await ready(start({ a: { cmd: h.prog('out:a1', 'forever') },
									  gone: { cmd: h.prog('forever') } }));
		await d.waitFor(/a +\| .* a1/);
		await d.waitFor(/gone started/);
		const oldA = pidOf(d, 'a');
		h.writeConfig(file, cfg({ a: { cmd: h.prog('out:a2', 'forever') }, fresh: { cmd: h.prog('out:f', 'forever') } }));
		assert.equal(ok([ 'restart' ]).stdout, 'a restarted\nfresh started\ngone stopped\n');
		await d.waitFor(/a +\| .* a2/);
		await d.waitFor(/fresh +\| .* f\n/);
		assert.notEqual(pidOf(d, 'a'), oldA);
		assert.deepEqual(Array.from(status().keys()), [ 'a', 'fresh' ]);
		assert.match(d.stdout, /control: restart\n/);
	});

	it('restarts only the named programs', async function() {
		const d = await ready(start({ a: { cmd: h.prog('forever') }, b: { cmd: h.prog('forever') } }));
		await d.waitFor(/b started/);
		const a0 = pidOf(d, 'a'), b0 = pidOf(d, 'b');
		assert.equal(ok([ 'restart', 'b' ]).stdout, 'b restarted\n');
		await h.waitUntil(() => (pidOf(d, 'b') !== b0), 3000, 'b to restart');
		assert.equal(pidOf(d, 'a'), a0);
		assert.equal(status().get('a').pid, a0);
	});

	it('keeps removed programs running until they are named', async function() {
		const d = await ready(start({ a: { cmd: h.prog('forever') }, b: { cmd: h.prog('forever') } }));
		await d.waitFor(/b started/);
		h.writeConfig(file, cfg({ a: { cmd: h.prog('forever') } }));
		assert.equal(ok([ 'restart', 'a' ]).stdout, 'a restarted\n');
		assert.equal(status().get('b').state, 'running');
		assert.equal(ok([ 'restart', 'b' ]).stdout, 'b stopped\n');
		assert.deepEqual(Array.from(status().keys()), [ 'a' ]);
	});

	it('does not restart a removed program when it exits', async function() {
		const d = await ready(start({ a: { cmd: h.prog('forever') }, b: { cmd: h.prog('sleep:600', 'exit:1') } }));
		await d.waitFor(/b started/);
		h.writeConfig(file, cfg({ a: { cmd: h.prog('forever') } }));
		ok([ 'restart', 'a' ]);
		await d.waitFor(/b exited with code 1, not restarting \(no longer in the config\)/);
		await h.waitUntil(() => (! status().has('b')), 3000, 'b to be dropped');
	});

	it('does not restart a waiting program that has been disabled', async function() {
		const d = await ready(start({ a: { cmd: h.prog('forever') }, b: { cmd: h.prog('exit:1'), restartDelay: 0.6 } }));
		await d.waitFor(/b exited with code 1, restarting/);
		h.writeConfig(file, cfg({ a: { cmd: h.prog('forever') }, b: { cmd: h.prog('exit:1'), restartDelay: 0.6, enabled: false } }));
		ok([ 'restart', 'a' ]);
		await d.waitFor(/b is disabled, not restarting/);
		assert.equal(d.count(/b started/), 1);
	});

	it('starts a named program that is new in the config', async function() {
		const d = await ready(start({ a: { cmd: h.prog('forever') } }));
		h.writeConfig(file, cfg({ a: { cmd: h.prog('forever') }, b: { cmd: h.prog('out:new', 'forever') } }));
		assert.equal(ok([ 'restart', 'b' ]).stdout, 'b started\n');
		await d.waitFor(/b +\| .* new/);
	});

	it('changes nothing for an unknown name or an invalid config', async function() {
		const d = await ready(start({ a: { cmd: h.prog('forever') } }));
		await d.waitFor(/a started/);
		const a0 = pidOf(d, 'a');
		let r = ctl([ '-s', sock, 'restart', 'a', 'nope' ]);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /^tr-cli-daemon-ctl: daemon: unknown program: nope\n$/);
		fs.writeFileSync(file, '{"programs": {"a": {"cmd": []}}}');
		r = ctl([ '-s', sock, 'restart' ]);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /programs\.a\.cmd: must be/);
		await d.waitFor(/@daemon ! .* control: restart refused, Invalid config/);
		assert.equal(status().get('a').pid, a0);
	});

	it('prints the raw response with --json', async function() {
		await ready(start({ a: { cmd: h.prog('forever') } }));
		const r = ok([ '--json', 'restart', 'a' ]);
		assert.deepEqual(JSON.parse(r.stdout), { ok: true, result: [ { name: 'a', action: 'restarted' } ] });
		const e = ctl([ '-s', sock, '--json', 'restart', 'x' ]);
		assert.equal(e.status, 1);
		assert.deepEqual(JSON.parse(e.stdout), { ok: false, error: 'unknown program: x' });
	});
});

describe('tr-cli-daemon-ctl quit', function() {
	it('stops the programs and the daemon', async function() {
		const d = await ready(start({ a: { cmd: h.prog('term-exit', 'forever') } }));
		await d.waitFor(/a started/);
		const pid = pidOf(d, 'a');
		const r = ok([ 'quit' ]);
		assert.equal(r.stdout, '');
		// The reply comes after the programs have stopped.
		assert.equal(h.isAlive(pid), false);
		assert.deepEqual(await d.exited, { code: 0, signal: null });
		assert.match(d.stdout, /a stopped \(exited with code 0\)\n[^]*shutdown complete\n/);
		assert.match(d.stdout, /control: quit, shutting down/);
		assert.equal(fs.existsSync(sock), false);
	});

	it('answers busy while a command is running', async function() {
		const d = await ready(start({ a: { cmd: h.prog('ignore-term', 'forever') } }, { killTimeout: 1.5 }));
		await d.waitFor(/a started/);
		await new Promise((r) => setTimeout(r, 200));
		const q = ctlAsync([ '-s', sock, 'quit' ]);
		await d.waitFor(/shutting down/);
		const r = ctl([ '-s', sock, 'status' ]);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /daemon: busy/);
		assert.equal((await q).status, 0);
		assert.equal((await d.exited).code, 0);
	});
});

describe('tr-cli-daemon-ctl errors', function() {
	it('needs a control socket', function() {
		const r = ctl([ 'status' ]);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /no control socket given/);
	});

	it('reports a missing daemon', function() {
		const r = ctl([ '-s', sock, 'status' ]);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /no daemon at .* \(socket not found\)/);
	});

	it('times out', async function() {
		const s = net.createServer(() => {});
		await new Promise((r) => s.listen(sock, r));
		try {
			const r = await ctlAsync([ '-s', sock, '--timeout=0.3', 'status' ]);
			assert.equal(r.status, 1);
			assert.match(r.stderr, /no reply from the daemon within 0\.3 s/);
		} finally {
			s.close();
		}
	});

	it('checks command parameters', function() {
		assert.equal(ctl([ '-s', sock, 'quit', 'now' ]).status, 1);
		assert.equal(ctl([ '-s', sock, 'status', 'a' ]).status, 1);
		assert.match(ctl([ '-s', sock, 'frob' ]).stderr, /unknown command "frob"/);
	});

	it('prints help', function() {
		const r = ctl([ '--help' ]);
		assert.equal(r.status, 0);
		assert.match(r.stdout, /Commands:\n  restart .*\n  quit .*\n  status /);
		assert.match(ctl([ 'help', 'restart' ]).stdout, /restart \[<opt> \.\.\.\] \[ <param> \.\.\.\]\n/);
	});
});
