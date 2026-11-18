'use strict';

// Shared helpers for the integration tests: temp dirs, config files and
// a harness that runs the daemon and waits for output.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DAEMON = path.join(ROOT, 'bin', 'tr-cli-daemon.js');
const CTL = path.join(ROOT, 'bin', 'tr-cli-daemon-ctl.js');
const PROG = path.join(__dirname, 'fixtures', 'prog.js');

function tmpDir(tag) {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'tr-cli-daemon-' + tag + '-'));
}

// A command line running the fixture program with the given steps.
function prog(...steps) {
	return [ process.execPath, PROG ].concat(steps);
}

function writeConfig(file, raw) {
	fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
	return file;
}

function cleanEnv(extra) {
	const e = Object.assign({}, process.env);
	for (const k of Object.keys(e)) {
		if (k.startsWith('TR_CLI_DAEMON_')) {
			delete e[k];
		}
	}
	return Object.assign(e, extra || {});
}

function waitUntil(check, ms, what) {
	return new Promise(function(resolve, reject) {
		const t0 = Date.now();
		(function poll() {
			let r;
			try {
				r = check();
			} catch (e) {
				reject(e);
				return;
			}
			if (r) {
				resolve(r);
			} else if ((Date.now() - t0) > ms) {
				reject(new Error('timed out waiting for ' + what));
			} else {
				setTimeout(poll, 20);
			}
		})();
	});
}

class Daemon {
	constructor(args, env) {
		this.stdout = '';
		this.stderr = '';
		this.proc = spawn(process.execPath, [ DAEMON ].concat(args), { env: cleanEnv(env), stdio: [ 'ignore', 'pipe', 'pipe' ] });
		this.proc.stdout.setEncoding('utf8');
		this.proc.stderr.setEncoding('utf8');
		this.proc.stdout.on('data', (d) => { this.stdout += d; });
		this.proc.stderr.on('data', (d) => { this.stderr += d; });
		this.exited = new Promise((resolve) => {
			this.proc.on('close', (code, signal) => resolve({ code: code, signal: signal }));
		});
		this.done = false;
		this.exited.then(() => { this.done = true; });
	}

	lines() {
		return this.stdout.split('\n').filter((l) => (l !== ''));
	}

	// Lines of one program (or @daemon) as [marker, text] without the
	// timestamp.
	of(name) {
		const re = /^(\S+) +([|!]) \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (.*)$/;
		return this.lines().map((l) => l.match(re)).filter((m) => (m && (m[1] === name))).map((m) => [ m[2], m[3] ]);
	}

	texts(name) {
		return this.of(name).map((x) => x[1]);
	}

	waitFor(re, ms) {
		return waitUntil(() => re.test(this.stdout), ms || 5000, re + ' in daemon output:\n' + this.stdout + this.stderr);
	}

	count(re) {
		return this.lines().filter((l) => re.test(l)).length;
	}

	waitCount(re, n, ms) {
		return waitUntil(() => (this.count(re) >= n), ms || 5000, n + ' x ' + re + ' in daemon output:\n' + this.stdout);
	}

	signal(sig) {
		this.proc.kill(sig);
	}

	async stop() {
		if (! this.done) {
			this.proc.kill('SIGTERM');
		}
		return this.exited;
	}
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e.code === 'EPERM');
	}
}

module.exports = {
	ROOT,
	DAEMON,
	CTL,
	PROG,
	tmpDir,
	prog,
	writeConfig,
	cleanEnv,
	waitUntil,
	Daemon,
	isAlive
};
