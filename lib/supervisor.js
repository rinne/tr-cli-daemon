'use strict';

// Process lifecycle: spawning programs in their own process groups,
// wiring their stdio, applying restart policies, and stopping them with
// SIGTERM followed by SIGKILL after the kill timeout.

const { spawn } = require('node:child_process');
const EventEmitter = require('node:events');

// After 'exit', wait this long for the stdio pipes to close so that the
// last output lines are logged before the exit message. A grandchild
// holding the pipes open must not delay the restart forever.
const CLOSE_GRACE_MS = 500;

function seconds(n) {
	return n + ' s';
}

function exitText(code, signal) {
	return (signal !== null) ? ('was killed by signal ' + signal) : ('exited with code ' + code);
}

function childEnv(env) {
	const r = Object.assign({}, process.env);
	for (const [ k, v ] of Object.entries(env)) {
		if (v === null) {
			delete r[k];
		} else {
			r[k] = v;
		}
	}
	return r;
}

// Signal the whole process group, falling back to the process itself.
function signalGroup(pid, signal) {
	try {
		process.kill(-pid, signal);
		return true;
	} catch (e) {
		try {
			process.kill(pid, signal);
			return true;
		} catch (e2) {
			return false;
		}
	}
}

class Program {
	constructor(sup, def) {
		this._sup = sup;
		this.def = def;
		this.state = 'stopped';
		this.since = new Date();
		this.pid = null;
		this.restarts = 0;
		this.starts = 0;
		this.lastExit = null;
		this._child = null;
		this._restartTimer = null;
		this._killTimer = null;
		this._stopping = false;
		this._stopWaiters = [];
		// Removed from the config but still running: never restarted,
		// dropped from the supervisor once stopped.
		this.orphan = false;
	}

	get name() {
		return this.def.name;
	}

	_setState(s) {
		this.state = s;
		this.since = new Date();
	}

	_log(text, isErr) {
		this._sup.output.daemon(this.name + ' ' + text, isErr);
	}

	start() {
		if ((this.state === 'running') || (this.state === 'stopping')) {
			return;
		}
		this._clearRestartTimer();
		const def = this.def;
		const out = this._sup.output;
		if (this.starts > 0) {
			this.restarts++;
		}
		this.starts++;
		this._stopping = false;
		let child;
		try {
			child = spawn(def.cmd[0], def.cmd.slice(1), {
				cwd: (def.cwd !== null) ? def.cwd : undefined,
				env: childEnv(def.env),
				stdio: [ 'pipe', 'pipe', 'pipe' ],
				detached: true
			});
		} catch (e) {
			this._spawnFailed(e);
			return;
		}
		this._child = child;
		this._setState('running');
		let exited = false, closed = false, exitInfo = null, graceTimer = null;
		const finish = () => {
			if (graceTimer !== null) {
				clearTimeout(graceTimer);
				graceTimer = null;
			}
			if (this._child !== child) {
				return;
			}
			this._child = null;
			if (exitInfo.error) {
				this._spawnFailed(exitInfo.error);
			} else {
				this._exited(exitInfo.code, exitInfo.signal);
			}
		};
		child.on('error', (e) => {
			// Without a pid the spawn itself failed and no exit event
			// follows. Other errors (failed kill) are not fatal.
			if ((child.pid === undefined) && (! exited)) {
				exited = true;
				exitInfo = { error: e };
				finish();
			}
		});
		child.on('exit', (code, signal) => {
			if (exited) {
				return;
			}
			exited = true;
			exitInfo = { code: code, signal: signal };
			if (closed) {
				finish();
			} else {
				graceTimer = setTimeout(finish, CLOSE_GRACE_MS);
			}
		});
		child.on('close', () => {
			closed = true;
			if (exited && (exitInfo !== null) && (! exitInfo.error)) {
				finish();
			}
		});
		if (child.pid !== undefined) {
			this.pid = child.pid;
			this._log('started, pid ' + child.pid);
		}
		child.stdin.on('error', function() {});
		if (def.stdin !== '') {
			child.stdin.write(def.stdin);
		}
		if (def.closeStdin) {
			child.stdin.end();
		}
		for (const [ stream, isErr, discard ] of [ [ child.stdout, false, def.discardStdout ],
												   [ child.stderr, true, def.discardStderr ] ]) {
			stream.on('error', function() {});
			if (discard) {
				stream.resume();
			} else {
				const sp = out.splitter(this.name, isErr);
				stream.on('data', (d) => sp.push(d));
				stream.on('end', () => sp.end());
			}
		}
	}

	_spawnFailed(e) {
		this.pid = null;
		this.lastExit = { code: null, signal: null, error: e.message };
		this._afterExit('failed to start: ' + e.message, true);
	}

	_exited(code, signal) {
		this.pid = null;
		this.lastExit = { code: code, signal: signal };
		const failure = (code !== 0) || (signal !== null);
		this._afterExit(exitText(code, signal), failure);
	}

	_afterExit(text, failure) {
		this._clearKillTimer();
		if (this._stopping) {
			this._stopping = false;
			this._setState('stopped');
			this._log('stopped (' + text + ')');
			this._resolveStop();
			this._sup._changed();
			return;
		}
		const def = this.def;
		const restart = (! this._sup.shuttingDown) && (! this.orphan) &&
			  ((def.restart === 'auto') || ((def.restart === 'on-failure') && failure));
		if (restart) {
			this._setState('waiting');
			this._log(text + ', restarting in ' + seconds(def.restartDelay), failure);
			this._restartTimer = setTimeout(() => {
				this._restartTimer = null;
				// The config may have changed while waiting.
				if (this.def.enabled && (! this.orphan)) {
					this.start();
				} else {
					this._setState('stopped');
					this._log(this.orphan ? 'is no longer in the config, not restarting' : 'is disabled, not restarting');
					this._sup._changed();
				}
			}, def.restartDelay * 1000);
		} else {
			this._setState('stopped');
			this._log(text + ', not restarting' + (this.orphan ? ' (no longer in the config)' : ''), failure);
		}
		this._resolveStop();
		this._sup._changed();
	}

	_clearRestartTimer() {
		if (this._restartTimer !== null) {
			clearTimeout(this._restartTimer);
			this._restartTimer = null;
		}
	}

	_clearKillTimer() {
		if (this._killTimer !== null) {
			clearTimeout(this._killTimer);
			this._killTimer = null;
		}
	}

	_resolveStop() {
		const w = this._stopWaiters;
		this._stopWaiters = [];
		w.forEach((f) => f());
	}

	// Stop the program: cancel a pending restart, or send SIGTERM to the
	// process group and SIGKILL after killTimeout. Resolves once the
	// program is stopped.
	stop() {
		if (this.state === 'waiting') {
			this._clearRestartTimer();
			this._setState('stopped');
			this._sup._changed();
			return Promise.resolve();
		}
		if (this.state === 'stopped') {
			return Promise.resolve();
		}
		const p = new Promise((resolve) => this._stopWaiters.push(resolve));
		if (this.state === 'running') {
			this._stopping = true;
			this._setState('stopping');
			signalGroup(this._child.pid, 'SIGTERM');
			const kt = this._sup.config.global.killTimeout;
			this._killTimer = setTimeout(() => {
				this._killTimer = null;
				if (this._child !== null) {
					this._log('did not stop in ' + seconds(kt) + ', sending SIGKILL', true);
					signalGroup(this._child.pid, 'SIGKILL');
				}
			}, kt * 1000);
		}
		return p;
	}

	kill() {
		if ((this._child !== null) && (this._child.pid !== undefined)) {
			signalGroup(this._child.pid, 'SIGKILL');
		}
	}

	get active() {
		return (this.state !== 'stopped');
	}

	status() {
		return {
			name: this.name,
			enabled: this.def.enabled,
			state: this.state,
			pid: this.pid,
			since: this.since.toISOString(),
			restarts: this.restarts,
			lastExit: (this.lastExit === null) ? null : Object.assign({}, this.lastExit)
		};
	}
}

// Emits 'idle' when no program is running, stopping or waiting to
// restart (and no shutdown is in progress).
class Supervisor extends EventEmitter {
	constructor(cfg, output) {
		super();
		this.config = cfg;
		this.output = output;
		this.shuttingDown = false;
		this._programs = new Map();
		for (const def of cfg.programs) {
			this._programs.set(def.name, new Program(this, def));
		}
		this.output.setNames(this._names());
	}

	_names() {
		return Array.from(this._programs.keys());
	}

	programs() {
		return Array.from(this._programs.values());
	}

	get(name) {
		return this._programs.get(name);
	}

	start() {
		for (const p of this._programs.values()) {
			if (p.def.enabled) {
				p.start();
			} else {
				this.output.daemon(p.name + ' is disabled, not starting');
			}
		}
		this._changed();
	}

	isIdle() {
		return this.programs().every((p) => (! p.active));
	}

	_changed() {
		for (const [ name, p ] of this._programs) {
			if (p.orphan && (! p.active)) {
				this._programs.delete(name);
				this.output.setNames(this._names());
			}
		}
		if ((! this.shuttingDown) && this.isIdle()) {
			// Deferred so that a caller in the middle of a change (such as
			// a restart) can start programs before idleness is acted on.
			setImmediate(() => {
				if ((! this.shuttingDown) && this.isIdle()) {
					this.emit('idle');
				}
			});
		}
	}

	// Stop everything; resolves when all programs have stopped.
	shutdown() {
		this.shuttingDown = true;
		return Promise.all(this.programs().map((p) => p.stop())).then(function() {});
	}

	// Switch to a new (validated, normalized) config and restart
	// programs. Without names every program is stopped and every enabled
	// one started. With names only those are stopped and started (if
	// enabled in the new config); the others keep running and use their
	// new settings from their next restart on. Programs removed from the
	// config keep running until they stop, and are then dropped.
	// Resolves with a list of { name, action } where action is
	// 'restarted', 'started' or 'stopped'.
	async restart(newCfg, names) {
		if (this.shuttingDown) {
			throw new Error('shutting down');
		}
		const newDefs = new Map(newCfg.programs.map((d) => [ d.name, d ]));
		const all = (names.length === 0);
		// Result order: new config order, then programs being removed.
		const selected = all ? Array.from(new Set(Array.from(newDefs.keys()).concat(this._names()))) : names;
		for (const n of selected) {
			if ((! this._programs.has(n)) && (! newDefs.has(n))) {
				throw new Error('unknown program: ' + n);
			}
		}
		const wasActive = new Map(selected.map((n) => [ n, this._programs.has(n) && this._programs.get(n).active ]));
		await Promise.all(selected.filter((n) => this._programs.has(n)).map((n) => this._programs.get(n).stop()));
		if (this.shuttingDown) {
			throw new Error('shutting down');
		}
		// Rebuild in new config order, then the still running orphans.
		const programs = new Map();
		for (const def of newCfg.programs) {
			const p = this._programs.get(def.name) || new Program(this, def);
			p.def = def;
			p.orphan = false;
			programs.set(def.name, p);
		}
		for (const [ n, p ] of this._programs) {
			if ((! programs.has(n)) && p.active) {
				p.orphan = true;
				programs.set(n, p);
			}
		}
		this.config = newCfg;
		this._programs = programs;
		this.output.setNames(this._names());
		const result = [];
		for (const n of selected) {
			const p = this._programs.get(n);
			const start = (p !== undefined) && (! p.orphan) && p.def.enabled;
			if (start) {
				p.start();
				result.push({ name: n, action: wasActive.get(n) ? 'restarted' : 'started' });
			} else if (wasActive.get(n)) {
				result.push({ name: n, action: 'stopped' });
			}
		}
		this._changed();
		return result;
	}

	killAll() {
		for (const p of this._programs.values()) {
			p.kill();
		}
	}

	status() {
		return this.programs().map((p) => p.status());
	}
}

module.exports = {
	Supervisor,
	Program,
	CLOSE_GRACE_MS
};
