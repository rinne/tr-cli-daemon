'use strict';

// tr-cli-daemon: load the config, start the programs, log their output
// and handle signals.

const path = require('node:path');
const Optist = require('optist');
const ou = require('optist/util');

const config = require('./config.js');
const output = require('./output.js');
const { Supervisor } = require('./supervisor.js');
const control = require('./control.js');

const NAME = 'tr-cli-daemon';
const VERSION = require('../package.json').version;

function parseArgs(argv) {
	return ((new Optist())
			.opts([ { shortName: 'c', longName: 'config', hasArg: true, required: true,
					  optArgCb: ou.nonEmptyCb, environment: 'TR_CLI_DAEMON_CONFIG',
					  description: 'Config file (environment TR_CLI_DAEMON_CONFIG)' },
					{ shortName: 'l', longName: 'logfile', hasArg: true,
					  optArgCb: ou.nonEmptyCb, environment: 'TR_CLI_DAEMON_LOGFILE',
					  description: 'Append output to this file instead of stdout (environment TR_CLI_DAEMON_LOGFILE)' },
					{ shortName: 's', longName: 'control-socket', hasArg: true,
					  optArgCb: ou.nonEmptyCb, environment: 'TR_CLI_DAEMON_CONTROL_SOCKET',
					  description: 'Listen for tr-cli-daemon-ctl commands on this Unix socket (environment TR_CLI_DAEMON_CONTROL_SOCKET)' } ])
			.additional(0, 0)
			.help(NAME)
			.helpMessageHead('Keep the programs listed in the config file running.')
			.helpMessageTail('Signals: SIGTERM or SIGINT stops all programs and exits (twice: SIGKILL at once),\n' +
							 'SIGHUP reopens the log file.')
			.parse(Array.from(argv)));
}

function die(message) {
	process.stderr.write(NAME + ': ' + message + '\n');
	process.exit(1);
}

async function main(argv) {
	const opt = parseArgs(argv);
	const configFile = path.resolve(opt.value('config'));
	const socketPath = (opt.value('control-socket') !== undefined) ? path.resolve(opt.value('control-socket')) : null;
	let loaded;
	try {
		loaded = config.load(configFile);
	} catch (e) {
		die(e.message);
	}
	const cfg = loaded.config;
	const noneEnabled = ! cfg.programs.some((p) => p.enabled);
	if (noneEnabled && (socketPath === null)) {
		die('no enabled programs in ' + configFile);
	}
	let sink;
	try {
		sink = new output.Sink((opt.value('logfile') !== undefined) ? path.resolve(opt.value('logfile')) : null);
	} catch (e) {
		die('cannot open log file: ' + e.message);
	}
	const out = new output.Output(sink, []);
	const sup = new Supervisor(cfg, out);
	let server = null;

	let exiting = false;
	function exit(code) {
		if (exiting) {
			return;
		}
		exiting = true;
		if (server !== null) {
			server.close();
		}
		out.close().then(() => process.exit(code), () => process.exit(code));
	}

	// Resolves when all programs have stopped. A second call while
	// shutting down kills everything at once and returns null.
	let shutdownStarted = false;
	function shutdown(why) {
		if (shutdownStarted) {
			out.daemon(why + ' again, sending SIGKILL to all programs', true);
			sup.killAll();
			return null;
		}
		shutdownStarted = true;
		if (server !== null) {
			server.refuse();
		}
		out.daemon(why + ', shutting down');
		return sup.shutdown().then(function() {
			out.daemon('shutdown complete');
		});
	}

	function signalShutdown(why) {
		const p = shutdown(why);
		if (p !== null) {
			p.then(() => exit(0));
		}
	}

	async function command(req) {
		const what = req.command + ((req.args.length > 0) ? (' ' + req.args.join(' ')) : '');
		switch (req.command) {
		case 'restart': {
			out.daemon('control: ' + what);
			let loaded;
			try {
				loaded = config.load(configFile);
			} catch (e) {
				out.daemon('control: restart refused, ' + e.message.replace(/\n\s*/g, ' '), true);
				throw e;
			}
			return sup.restart(loaded.config, req.args);
		}
		case 'quit': {
			if (req.args.length > 0) {
				throw new Error('quit takes no arguments');
			}
			await shutdown('control: quit');
			return { result: null, after: () => exit(0) };
		}
		case 'status':
			if (req.args.length > 0) {
				throw new Error('status takes no arguments');
			}
			return sup.status();
		default:
			throw new Error('unknown command: ' + req.command);
		}
	}

	if (socketPath !== null) {
		server = new control.Server(socketPath, command);
		try {
			await server.listen();
		} catch (e) {
			server = null;
			die(e.message);
		}
	}

	process.on('SIGTERM', () => signalShutdown('got SIGTERM'));
	process.on('SIGINT', () => signalShutdown('got SIGINT'));
	process.on('SIGHUP', function() {
		if (sink.file === null) {
			out.daemon('got SIGHUP, no log file to reopen');
			return;
		}
		const e = out.reopen();
		if (e) {
			out.daemon('got SIGHUP, cannot reopen log file: ' + e.message, true);
		} else {
			out.daemon('got SIGHUP, reopened log file');
		}
	});
	process.on('uncaughtException', function(e) {
		try {
			out.daemon('internal error: ' + ((e && e.stack) ? e.stack : String(e)), true);
		} catch (e2) {
			/* nothing more to do */
		}
		sup.killAll();
		exit(1);
	});

	sup.on('idle', function() {
		if (shutdownStarted) {
			return;
		}
		if (server !== null) {
			out.daemon('no programs running, waiting for control commands');
		} else {
			out.daemon('no programs left to run, exiting');
			exit(0);
		}
	});

	out.daemon('starting ' + NAME + ' ' + VERSION + ', pid ' + process.pid + ', config ' + configFile +
			   ((server !== null) ? (', control socket ' + socketPath) : ''));
	if (noneEnabled) {
		out.daemon('no enabled programs in the config', true);
	}
	sup.start();
}

module.exports = {
	main
};
