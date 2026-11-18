'use strict';

// tr-cli-daemon: load the config, start the programs, log their output
// and handle signals.

const path = require('node:path');
const Optist = require('optist');
const ou = require('optist/util');

const config = require('./config.js');
const output = require('./output.js');
const { Supervisor } = require('./supervisor.js');

const NAME = 'tr-cli-daemon';
const VERSION = require('../package.json').version;

function parseArgs(argv) {
	return ((new Optist())
			.opts([ { shortName: 'c', longName: 'config', hasArg: true, required: true,
					  optArgCb: ou.nonEmptyCb, environment: 'TR_CLI_DAEMON_CONFIG',
					  description: 'Config file (environment TR_CLI_DAEMON_CONFIG)' },
					{ shortName: 'l', longName: 'logfile', hasArg: true,
					  optArgCb: ou.nonEmptyCb, environment: 'TR_CLI_DAEMON_LOGFILE',
					  description: 'Append output to this file instead of stdout (environment TR_CLI_DAEMON_LOGFILE)' } ])
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

function main(argv) {
	const opt = parseArgs(argv);
	const configFile = path.resolve(opt.value('config'));
	let loaded;
	try {
		loaded = config.load(configFile);
	} catch (e) {
		die(e.message);
	}
	const cfg = loaded.config;
	if (! cfg.programs.some((p) => p.enabled)) {
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

	let exiting = false;
	function exit(code) {
		if (exiting) {
			return;
		}
		exiting = true;
		out.close().then(() => process.exit(code), () => process.exit(code));
	}

	let shutdownStarted = false;
	function shutdown(why) {
		if (shutdownStarted) {
			out.daemon(why + ' again, sending SIGKILL to all programs', true);
			sup.killAll();
			return;
		}
		shutdownStarted = true;
		out.daemon(why + ', shutting down');
		sup.shutdown().then(function() {
			out.daemon('shutdown complete');
			exit(0);
		});
	}

	process.on('SIGTERM', () => shutdown('got SIGTERM'));
	process.on('SIGINT', () => shutdown('got SIGINT'));
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
		if (! shutdownStarted) {
			out.daemon('no programs left to run, exiting');
			exit(0);
		}
	});

	out.daemon('starting ' + NAME + ' ' + VERSION + ', pid ' + process.pid + ', config ' + configFile);
	sup.start();
}

module.exports = {
	main
};
