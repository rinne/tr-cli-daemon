'use strict';

// tr-cli-daemon-ctl: send commands to a running daemon over its
// control socket.

const ou = require('optist/util');

const cli = require('./cli.js');
const control = require('./control.js');

function exitText(e) {
	if (e === null) {
		return '-';
	}
	if (e.error !== undefined) {
		return 'error: ' + e.error;
	}
	if (e.signal !== null) {
		return 'signal ' + e.signal;
	}
	return 'code ' + e.code;
}

function table(rows) {
	const w = rows[0].map((x, i) => Math.max(...rows.map((r) => r[i].length)));
	return rows.map((r) => r.map((c, i) => ((i === (r.length - 1)) ? c : c.padEnd(w[i]))).join('  ').trimEnd()).join('\n') + '\n';
}

function formatStatus(list) {
	if (list.length === 0) {
		return 'no programs\n';
	}
	const rows = [ [ 'NAME', 'STATE', 'PID', 'SINCE', 'RESTARTS', 'LAST EXIT' ] ];
	for (const p of list) {
		rows.push([ p.name + (p.enabled ? '' : ' (disabled)'),
					p.state,
					(p.pid === null) ? '-' : String(p.pid),
					p.since,
					String(p.restarts),
					exitText(p.lastExit) ]);
	}
	return table(rows);
}

function formatRestart(list) {
	return list.map((x) => x.name + ' ' + x.action + '\n').join('');
}

function send(command, formatter) {
	return async function(ctx) {
		const g = ctx.global;
		const r = await control.request(g.value('control-socket'), command, ctx.params, g.value('timeout') * 1000);
		if (g.value('json')) {
			process.stdout.write(JSON.stringify(r) + '\n');
			return r.ok ? 0 : 1;
		}
		if (! r.ok) {
			throw new Error('daemon: ' + r.error);
		}
		if (formatter) {
			process.stdout.write(formatter(r.result));
		}
		return 0;
	};
}

const SPEC = {
	name: 'tr-cli-daemon-ctl',
	description: 'Send a command to a running tr-cli-daemon.',
	globalOpts: [ { shortName: 's', longName: 'control-socket', hasArg: true, optArgCb: ou.nonEmptyCb,
					environment: 'TR_CLI_DAEMON_CONTROL_SOCKET',
					description: 'Control socket of the daemon (environment TR_CLI_DAEMON_CONTROL_SOCKET)' },
				  { longName: 'timeout', hasArg: true, defaultValue: '60',
					optArgCb: cli.secondsCbFactory(false, 1000000),
					environment: 'TR_CLI_DAEMON_TIMEOUT',
					description: 'Seconds to wait for a reply, default 60 (environment TR_CLI_DAEMON_TIMEOUT)' },
				  { longName: 'json', description: 'Print the raw JSON response' } ],
	requiredGlobals: [ { name: 'control-socket',
						 message: 'no control socket given (use --control-socket or TR_CLI_DAEMON_CONTROL_SOCKET)' } ],
	commands: {
		'restart': {
			summary: 'Reload the config and restart all programs, or only the named ones',
			details: ('The config file is read again first; if it is invalid, nothing changes.\n' +
					  'Without names every program is stopped and every enabled one started.\n' +
					  'With names only those are restarted; the others keep running.'),
			params: [ 'name' ],
			min: 0,
			run: send('restart', formatRestart)
		},
		'quit': {
			summary: 'Stop all programs and the daemon',
			details: 'Returns when all programs have stopped.',
			min: 0, max: 0,
			run: send('quit', null)
		},
		'status': {
			summary: 'Show the state of each program',
			min: 0, max: 0,
			run: send('status', formatStatus)
		}
	}
};

module.exports = {
	SPEC,
	formatStatus,
	run: (argv) => cli.run(SPEC, argv)
};
