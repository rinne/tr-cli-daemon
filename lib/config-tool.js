'use strict';

// tr-cli-daemon-config: create and edit the config file.

const ou = require('optist/util');

const config = require('./config.js');
const cli = require('./cli.js');

const RESET_PROGRAM_KEYS = [ 'restart', 'restartDelay', 'cwd', 'env', 'stdin' ];
const RESET_GLOBAL_KEYS = [ 'restart', 'restartDelay', 'killTimeout' ];

function envAssignCb(s) {
	const i = s.indexOf('=');
	if (i < 1) {
		return undefined;
	}
	return { name: s.slice(0, i), value: s.slice(i + 1) };
}

function envNameCb(s) {
	return ((s !== '') && (s.indexOf('=') < 0)) ? s : undefined;
}

const OPT = {
	restart: { longName: 'restart', hasArg: true,
			   optArgCb: ou.allowListCbFactory(config.RESTART_POLICIES),
			   description: 'Restart policy: auto, on-failure or never' },
	restartDelay: { longName: 'restart-delay', hasArg: true,
					optArgCb: cli.secondsCbFactory(true, config.MAX_SECONDS),
					description: 'Seconds to wait before a restart' },
	killTimeout: { longName: 'kill-timeout', hasArg: true,
				   optArgCb: cli.secondsCbFactory(false, config.MAX_SECONDS),
				   description: 'Seconds from SIGTERM to SIGKILL at shutdown' },
	cwd: { longName: 'cwd', hasArg: true, optArgCb: ou.nonEmptyCb,
		   description: 'Working directory (relative to the config file directory)' },
	env: { longName: 'env', hasArg: true, multi: true, optArgCb: envAssignCb,
		   description: 'Set an environment variable, NAME=VALUE (repeatable)' },
	unsetEnv: { longName: 'unset-env', hasArg: true, multi: true, optArgCb: envNameCb,
				description: 'Remove a variable from the inherited environment (repeatable)' },
	removeEnv: { longName: 'remove-env', hasArg: true, multi: true, optArgCb: envNameCb,
				 description: 'Delete an env entry from the config (repeatable)' },
	stdin: { longName: 'stdin', hasArg: true, conflictsWith: 'stdin-file',
			 description: 'Text written to stdin after each start' },
	stdinFile: { longName: 'stdin-file', hasArg: true, optArgCb: ou.fileContentsStringCb,
				 conflictsWith: 'stdin',
				 description: 'Read the stdin text from a file' }
};

function flag(longName, description, conflictsWith) {
	const r = { longName: longName, description: description };
	if (conflictsWith) {
		r.conflictsWith = conflictsWith;
	}
	return r;
}

function configFile(ctx) {
	return ctx.global.value('config');
}

// Read and validate the existing config for modification.
function readForEdit(ctx) {
	const file = configFile(ctx);
	let raw;
	try {
		raw = config.readRaw(file);
	} catch (e) {
		if (/^Cannot read/.test(e.message)) {
			throw new Error(e.message + ' (create it with create-config)');
		}
		throw e;
	}
	return config.validate(raw, file);
}

// Rebuild an object with keys in the given order, dropping undefined.
function ordered(obj, keys) {
	const r = {};
	for (const k of keys) {
		if (obj[k] !== undefined) {
			r[k] = obj[k];
		}
	}
	for (const k of Object.keys(obj)) {
		if ((! keys.includes(k)) && (obj[k] !== undefined)) {
			r[k] = obj[k];
		}
	}
	return r;
}

function checkName(name) {
	if (! config.NAME_RE.test(name)) {
		throw new Error('invalid program name ' + JSON.stringify(name) +
						' (allowed: letters, digits, ".", "_" and "-", starting with a letter or digit, ' +
						'at most 64 characters)');
	}
}

function stdinValue(opt) {
	if (opt.value('stdin') !== undefined) {
		return opt.value('stdin');
	}
	return opt.value('stdin-file');
}

// Apply --env, --unset-env and --remove-env to an env object (or
// undefined). Returns the new env, or undefined if it ends up empty.
function applyEnv(env, opt, allowRemove) {
	const r = Object.assign({}, env || {});
	const seen = new Map();
	function claim(name, what) {
		if (seen.has(name)) {
			throw new Error('variable ' + name + ' given with both ' + seen.get(name) + ' and ' + what);
		}
		seen.set(name, what);
	}
	for (const a of opt.value('env')) {
		claim(a.name, '--env');
		r[a.name] = a.value;
	}
	for (const n of opt.value('unset-env')) {
		claim(n, '--unset-env');
		r[n] = null;
	}
	if (allowRemove) {
		for (const n of opt.value('remove-env')) {
			claim(n, '--remove-env');
			if (! Object.hasOwn(r, n)) {
				throw new Error('variable ' + n + ' is not in env');
			}
			delete r[n];
		}
	}
	return (Object.keys(r).length > 0) ? r : undefined;
}

function cmdCreateConfig(ctx) {
	config.save(configFile(ctx), { global: {}, programs: {} }, { exclusive: ! ctx.opt.value('force') });
}

function cmdAddProgram(ctx) {
	const [ name, ...cmd ] = ctx.params;
	checkName(name);
	const raw = readForEdit(ctx);
	if (Object.hasOwn(raw.programs, name)) {
		throw new Error('program ' + name + ' already exists');
	}
	const o = ctx.opt;
	const p = {
		cmd: cmd,
		enabled: o.value('disabled') ? false : undefined,
		restart: o.value('restart'),
		restartDelay: o.value('restart-delay'),
		cwd: o.value('cwd'),
		env: applyEnv(undefined, o, false),
		stdin: stdinValue(o),
		closeStdin: o.value('close-stdin') ? true : undefined,
		discardStdout: o.value('discard-stdout') ? true : undefined,
		discardStderr: o.value('discard-stderr') ? true : undefined
	};
	raw.programs[name] = ordered(p, config.PROGRAM_KEYS);
	config.save(configFile(ctx), raw);
}

function resetKeys(opt, allowed) {
	const r = opt.value('reset');
	for (const k of r) {
		if (! allowed.includes(k)) {
			throw new Error('--reset: unknown key ' + JSON.stringify(k) + ' (allowed: ' + allowed.join(', ') + ')');
		}
	}
	return r;
}

function cmdModifyProgram(ctx) {
	const [ name, ...cmd ] = ctx.params;
	const raw = readForEdit(ctx);
	if (! Object.hasOwn(raw.programs, name)) {
		throw new Error('no such program: ' + name);
	}
	const o = ctx.opt;
	const p = Object.assign({}, raw.programs[name]);
	const before = JSON.stringify(p);
	const resets = resetKeys(o, RESET_PROGRAM_KEYS);
	const setters = {
		restart: o.value('restart') !== undefined,
		restartDelay: o.value('restart-delay') !== undefined,
		cwd: o.value('cwd') !== undefined,
		env: (o.value('env').length + o.value('unset-env').length + o.value('remove-env').length) > 0,
		stdin: stdinValue(o) !== undefined
	};
	for (const k of resets) {
		if (setters[k]) {
			throw new Error('--reset=' + k + ' conflicts with an option setting ' + k);
		}
		delete p[k];
	}
	if (cmd.length > 0) {
		p.cmd = cmd;
	}
	if (setters.restart) {
		p.restart = o.value('restart');
	}
	if (setters.restartDelay) {
		p.restartDelay = o.value('restart-delay');
	}
	if (setters.cwd) {
		p.cwd = o.value('cwd');
	}
	if (setters.env) {
		p.env = applyEnv(p.env, o, true);
	}
	if (setters.stdin) {
		p.stdin = stdinValue(o);
	}
	// Booleans: a value equal to the default is removed from the file.
	if (o.value('enable')) {
		delete p.enabled;
	}
	if (o.value('disable')) {
		p.enabled = false;
	}
	for (const [ key, on, off ] of [ [ 'closeStdin', 'close-stdin', 'no-close-stdin' ],
									 [ 'discardStdout', 'discard-stdout', 'no-discard-stdout' ],
									 [ 'discardStderr', 'discard-stderr', 'no-discard-stderr' ] ]) {
		if (o.value(on)) {
			p[key] = true;
		}
		if (o.value(off)) {
			delete p[key];
		}
	}
	const newName = o.value('rename');
	if ((JSON.stringify(p) === before) && (newName === undefined) && (cmd.length === 0)) {
		throw new Error('nothing to change');
	}
	const entry = ordered(p, config.PROGRAM_KEYS);
	if ((newName !== undefined) && (newName !== name)) {
		checkName(newName);
		if (Object.hasOwn(raw.programs, newName)) {
			throw new Error('program ' + newName + ' already exists');
		}
		const programs = {};
		for (const [ k, v ] of Object.entries(raw.programs)) {
			if (k === name) {
				programs[newName] = entry;
			} else {
				programs[k] = v;
			}
		}
		raw.programs = programs;
	} else {
		raw.programs[name] = entry;
	}
	config.save(configFile(ctx), raw);
}

function cmdRemoveProgram(ctx) {
	const name = ctx.params[0];
	const raw = readForEdit(ctx);
	if (! Object.hasOwn(raw.programs, name)) {
		throw new Error('no such program: ' + name);
	}
	delete raw.programs[name];
	config.save(configFile(ctx), raw);
}

function cmdModifyGlobal(ctx) {
	const raw = readForEdit(ctx);
	const o = ctx.opt;
	const g = Object.assign({}, raw.global || {});
	const values = {
		restart: o.value('restart'),
		restartDelay: o.value('restart-delay'),
		killTimeout: o.value('kill-timeout')
	};
	const resets = resetKeys(o, RESET_GLOBAL_KEYS);
	for (const k of resets) {
		if (values[k] !== undefined) {
			throw new Error('--reset=' + k + ' conflicts with an option setting ' + k);
		}
		delete g[k];
	}
	for (const [ k, v ] of Object.entries(values)) {
		if (v !== undefined) {
			g[k] = v;
		}
	}
	if ((resets.length === 0) && Object.values(values).every((v) => (v === undefined))) {
		throw new Error('nothing to change');
	}
	const out = { global: ordered(g, config.GLOBAL_KEYS) };
	for (const [ k, v ] of Object.entries(raw)) {
		if (k !== 'global') {
			out[k] = v;
		}
	}
	config.save(configFile(ctx), ordered(out, [ 'global', 'programs' ]));
}

function cmdShow(ctx) {
	const raw = readForEdit(ctx);
	if (ctx.params.length > 0) {
		const name = ctx.params[0];
		if (! Object.hasOwn(raw.programs, name)) {
			throw new Error('no such program: ' + name);
		}
		process.stdout.write(config.serialize(raw.programs[name]));
	} else {
		process.stdout.write(config.serialize(raw));
	}
}

const PROGRAM_OPTS_COMMON = [ OPT.restart, OPT.restartDelay, OPT.cwd, OPT.env, OPT.unsetEnv,
							  OPT.stdin, OPT.stdinFile ];

const SPEC = {
	name: 'tr-cli-daemon-config',
	description: 'Create and edit a tr-cli-daemon config file.',
	globalOpts: [ { shortName: 'c', longName: 'config', hasArg: true, optArgCb: ou.nonEmptyCb,
					environment: 'TR_CLI_DAEMON_CONFIG',
					description: 'Config file (environment TR_CLI_DAEMON_CONFIG)' } ],
	requiredGlobals: [ { name: 'config', message: 'no config file given (use --config or TR_CLI_DAEMON_CONFIG)' } ],
	commands: {
		'create-config': {
			summary: 'Create a new config with no programs',
			opts: [ flag('force', 'Overwrite an existing file') ],
			min: 0, max: 0,
			run: cmdCreateConfig
		},
		'add-program': {
			summary: 'Add a program',
			details: ('Everything from <cmd> on is the program command line; options after it\n' +
					  'belong to the program, not to this tool.\n' +
					  'Example:\n' +
					  '  tr-cli-daemon-config -c d.json add-program --restart-delay=5 web /usr/bin/web --port 80'),
			opts: [ flag('disabled', 'Add the program disabled') ]
				.concat(PROGRAM_OPTS_COMMON)
				.concat([ flag('close-stdin', 'Close stdin after the stdin text'),
						  flag('discard-stdout', 'Read but do not log stdout'),
						  flag('discard-stderr', 'Read but do not log stderr') ]),
			params: [ 'name', 'cmd' ],
			min: 2,
			run: cmdAddProgram
		},
		'modify-program': {
			summary: 'Change a program',
			details: ('A <cmd> with optional arguments replaces the command line.\n' +
					  '--reset keys: ' + RESET_PROGRAM_KEYS.join(', ')),
			opts: PROGRAM_OPTS_COMMON
				.concat([ OPT.removeEnv,
						  flag('enable', 'Enable the program', 'disable'),
						  flag('disable', 'Disable the program', 'enable'),
						  flag('close-stdin', 'Close stdin after the stdin text', 'no-close-stdin'),
						  flag('no-close-stdin', 'Keep stdin open', 'close-stdin'),
						  flag('discard-stdout', 'Read but do not log stdout', 'no-discard-stdout'),
						  flag('no-discard-stdout', 'Log stdout', 'discard-stdout'),
						  flag('discard-stderr', 'Read but do not log stderr', 'no-discard-stderr'),
						  flag('no-discard-stderr', 'Log stderr', 'discard-stderr'),
						  { longName: 'reset', hasArg: true, multi: true,
							description: 'Remove a key so the default applies (repeatable)' },
						  { longName: 'rename', hasArg: true, optArgCb: ou.nonEmptyCb,
							description: 'Rename the program' } ]),
			params: [ 'name', 'cmd' ],
			min: 1,
			run: cmdModifyProgram
		},
		'remove-program': {
			summary: 'Remove a program',
			params: [ 'name' ],
			min: 1, max: 1,
			run: cmdRemoveProgram
		},
		'modify-global': {
			summary: 'Change the global defaults',
			details: '--reset keys: ' + RESET_GLOBAL_KEYS.join(', '),
			opts: [ OPT.restart, OPT.restartDelay, OPT.killTimeout,
					{ longName: 'reset', hasArg: true, multi: true,
					  description: 'Remove a key so the built-in default applies (repeatable)' } ],
			min: 0, max: 0,
			run: cmdModifyGlobal
		},
		'show': {
			summary: 'Print the config, or one program, as JSON',
			params: [ 'name' ],
			min: 0, max: 1,
			run: cmdShow
		}
	}
};

module.exports = {
	SPEC,
	run: (argv) => cli.run(SPEC, argv)
};
