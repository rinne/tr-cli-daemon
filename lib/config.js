'use strict';

// Config file model: reading, strict validation, normalization with
// defaults applied, and atomic saving. The same validation is used by
// the daemon and by the config tool, so whatever the tool writes the
// daemon accepts.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESTART_POLICIES = [ 'auto', 'on-failure', 'never' ];
const MAX_SECONDS = 1000000;

const DEFAULTS = Object.freeze({
	restart: 'auto',
	restartDelay: 10,
	killTimeout: 10
});

const TOP_KEYS = [ 'global', 'programs' ];
const GLOBAL_KEYS = [ 'restart', 'restartDelay', 'killTimeout' ];
const PROGRAM_KEYS = [ 'cmd', 'enabled', 'restart', 'restartDelay', 'cwd', 'env',
					   'stdin', 'closeStdin', 'discardStdout', 'discardStderr' ];

class ConfigError extends Error {
	constructor(message, problems) {
		super(message);
		this.name = 'ConfigError';
		this.problems = problems || [ message ];
	}
}

function isPlainObject(x) {
	return ((typeof(x) === 'object') && (x !== null) && (! Array.isArray(x)));
}

function isSeconds(x, allowZero) {
	return ((typeof(x) === 'number') &&
			Number.isFinite(x) &&
			(allowZero ? (x >= 0) : (x > 0)) &&
			(x <= MAX_SECONDS));
}

function hasNul(s) {
	return s.indexOf('\0') >= 0;
}

function checkUnknownKeys(obj, allowed, where, problems) {
	for (const k of Object.keys(obj)) {
		if (! allowed.includes(k)) {
			problems.push(where + ': unknown key ' + JSON.stringify(k));
		}
	}
}

function checkRestart(v, where, problems) {
	if (! RESTART_POLICIES.includes(v)) {
		problems.push(where + ': must be one of ' + RESTART_POLICIES.map((p) => JSON.stringify(p)).join(', '));
	}
}

function checkRestartDelay(v, where, problems) {
	if (! isSeconds(v, true)) {
		problems.push(where + ': must be a number of seconds from 0 to ' + MAX_SECONDS);
	}
}

function checkKillTimeout(v, where, problems) {
	if (! isSeconds(v, false)) {
		problems.push(where + ': must be a number of seconds greater than 0 and at most ' + MAX_SECONDS);
	}
}

function checkBoolean(v, where, problems) {
	if (typeof(v) !== 'boolean') {
		problems.push(where + ': must be true or false');
	}
}

function validateEnvName(name) {
	return ((typeof(name) === 'string') && (name !== '') && (name.indexOf('=') < 0) && (! hasNul(name)));
}

function validateGlobal(g, problems) {
	if (! isPlainObject(g)) {
		problems.push('global: must be an object');
		return;
	}
	checkUnknownKeys(g, GLOBAL_KEYS, 'global', problems);
	if (g.restart !== undefined) {
		checkRestart(g.restart, 'global.restart', problems);
	}
	if (g.restartDelay !== undefined) {
		checkRestartDelay(g.restartDelay, 'global.restartDelay', problems);
	}
	if (g.killTimeout !== undefined) {
		checkKillTimeout(g.killTimeout, 'global.killTimeout', problems);
	}
}

function validateProgram(name, p, problems) {
	const w = 'programs.' + name;
	if (! NAME_RE.test(name)) {
		problems.push(w + ': invalid program name (allowed: letters, digits, ".", "_" and "-", ' +
					  'starting with a letter or digit, at most 64 characters)');
	}
	if (! isPlainObject(p)) {
		problems.push(w + ': must be an object');
		return;
	}
	checkUnknownKeys(p, PROGRAM_KEYS, w, problems);
	if (p.cmd === undefined) {
		problems.push(w + '.cmd: missing');
	} else if (! (Array.isArray(p.cmd) &&
				  (p.cmd.length > 0) &&
				  p.cmd.every((a) => ((typeof(a) === 'string') && (! hasNul(a)))) &&
				  (p.cmd[0] !== ''))) {
		problems.push(w + '.cmd: must be a non-empty array of strings with a non-empty first element');
	}
	for (const k of [ 'enabled', 'closeStdin', 'discardStdout', 'discardStderr' ]) {
		if (p[k] !== undefined) {
			checkBoolean(p[k], w + '.' + k, problems);
		}
	}
	if (p.restart !== undefined) {
		checkRestart(p.restart, w + '.restart', problems);
	}
	if (p.restartDelay !== undefined) {
		checkRestartDelay(p.restartDelay, w + '.restartDelay', problems);
	}
	if ((p.cwd !== undefined) && (! ((typeof(p.cwd) === 'string') && (p.cwd !== '') && (! hasNul(p.cwd))))) {
		problems.push(w + '.cwd: must be a non-empty string');
	}
	if (p.env !== undefined) {
		if (! isPlainObject(p.env)) {
			problems.push(w + '.env: must be an object');
		} else {
			for (const [ k, v ] of Object.entries(p.env)) {
				if (! validateEnvName(k)) {
					problems.push(w + '.env: invalid variable name ' + JSON.stringify(k));
				} else if (! ((v === null) || ((typeof(v) === 'string') && (! hasNul(v))))) {
					problems.push(w + '.env.' + k + ': must be a string or null');
				}
			}
		}
	}
	if ((p.stdin !== undefined) && (typeof(p.stdin) !== 'string')) {
		problems.push(w + '.stdin: must be a string');
	}
}

// Return a list of problems, empty if the config is valid.
function problems(raw) {
	const r = [];
	if (! isPlainObject(raw)) {
		r.push('config: must be a JSON object');
		return r;
	}
	checkUnknownKeys(raw, TOP_KEYS, 'config', r);
	if (raw.global !== undefined) {
		validateGlobal(raw.global, r);
	}
	if (raw.programs === undefined) {
		r.push('programs: missing');
	} else if (! isPlainObject(raw.programs)) {
		r.push('programs: must be an object');
	} else {
		for (const [ name, p ] of Object.entries(raw.programs)) {
			validateProgram(name, p, r);
		}
	}
	return r;
}

function validate(raw, source) {
	const p = problems(raw);
	if (p.length > 0) {
		throw new ConfigError('Invalid config' + (source ? (' in ' + source) : '') + ':\n  ' + p.join('\n  '), p);
	}
	return raw;
}

// Turn a validated raw config into the form the daemon uses: defaults
// applied, cwd made absolute, programs as an array in config order.
function normalize(raw, configDir) {
	const g = Object.assign({}, DEFAULTS);
	for (const k of GLOBAL_KEYS) {
		if ((raw.global !== undefined) && (raw.global[k] !== undefined)) {
			g[k] = raw.global[k];
		}
	}
	const programs = Object.entries(raw.programs).map(function([ name, p ]) {
		return {
			name: name,
			cmd: Array.from(p.cmd),
			enabled: (p.enabled !== undefined) ? p.enabled : true,
			restart: (p.restart !== undefined) ? p.restart : g.restart,
			restartDelay: (p.restartDelay !== undefined) ? p.restartDelay : g.restartDelay,
			cwd: (p.cwd !== undefined) ? path.resolve(configDir, p.cwd) : null,
			env: Object.assign({}, p.env || {}),
			stdin: (p.stdin !== undefined) ? p.stdin : '',
			closeStdin: (p.closeStdin !== undefined) ? p.closeStdin : false,
			discardStdout: (p.discardStdout !== undefined) ? p.discardStdout : false,
			discardStderr: (p.discardStderr !== undefined) ? p.discardStderr : false
		};
	});
	return { global: g, programs: programs };
}

// Read and parse the file without validating it.
function readRaw(file) {
	let text;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (e) {
		throw new ConfigError('Cannot read config file ' + file + ': ' + e.message);
	}
	try {
		return JSON.parse(text);
	} catch (e) {
		throw new ConfigError('Config file ' + file + ' is not valid JSON: ' + e.message);
	}
}

// Read, validate and normalize. Returns { raw, config }.
function load(file) {
	const raw = validate(readRaw(file), file);
	return { raw: raw, config: normalize(raw, path.dirname(path.resolve(file))) };
}

function serialize(raw) {
	return JSON.stringify(raw, null, 2) + '\n';
}

// Validate and write atomically: a temp file in the same directory,
// fsync, then rename over the target. An existing file keeps its mode.
function save(file, raw, options) {
	validate(raw);
	const exclusive = !! (options && options.exclusive);
	const target = path.resolve(file);
	const dir = path.dirname(target);
	let mode = 0o666;
	try {
		const st = fs.statSync(target);
		if (exclusive) {
			throw new ConfigError('Config file ' + file + ' already exists');
		}
		if (! st.isFile()) {
			throw new ConfigError('Config file ' + file + ' is not a regular file');
		}
		mode = st.mode & 0o7777;
	} catch (e) {
		if (e instanceof ConfigError) {
			throw e;
		}
		if (e.code !== 'ENOENT') {
			throw new ConfigError('Cannot access config file ' + file + ': ' + e.message);
		}
	}
	const tmp = path.join(dir, '.' + path.basename(target) + '.' + process.pid + '.' +
						  crypto.randomBytes(6).toString('hex') + '.tmp');
	let fd;
	try {
		fd = fs.openSync(tmp, 'wx', mode);
		if (mode !== 0o666) {
			fs.fchmodSync(fd, mode);
		}
		fs.writeFileSync(fd, serialize(raw));
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		if (exclusive) {
			// link() fails if the target appeared in the meantime.
			fs.linkSync(tmp, target);
			fs.unlinkSync(tmp);
		} else {
			fs.renameSync(tmp, target);
		}
	} catch (e) {
		if (e instanceof ConfigError) {
			throw e;
		}
		if (exclusive && (e.code === 'EEXIST')) {
			try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
			throw new ConfigError('Config file ' + file + ' already exists');
		}
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch (e2) { /* ignore */ }
		}
		try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
		throw new ConfigError('Cannot write config file ' + file + ': ' + e.message);
	}
}

module.exports = {
	NAME_RE,
	RESTART_POLICIES,
	MAX_SECONDS,
	DEFAULTS,
	GLOBAL_KEYS,
	PROGRAM_KEYS,
	ConfigError,
	problems,
	validate,
	normalize,
	readRaw,
	load,
	save,
	serialize
};
