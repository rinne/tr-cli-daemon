'use strict';

// Two-stage command line parsing shared by tr-cli-daemon-config and
// tr-cli-daemon-ctl:
//
//   <tool> [<global-opt> ...] <command> [<command-opt> ...] [<param> ...]
//
// Stage one parses the global options with optist and stops at the
// first non-option. The command name is then taken by hand, and a
// parser specific to that command parses the rest with its own
// options and parameter limits.

const Optist = require('optist');

function commandList(spec) {
	const names = Object.keys(spec.commands);
	const w = Math.max(...names.map((n) => n.length), 4);
	return ('Commands:\n' +
			names.map((n) => '  ' + n.padEnd(w) + '  ' + spec.commands[n].summary).join('\n') + '\n' +
			'  ' + 'help'.padEnd(w) + '  Show help for a command\n' +
			'Run "' + spec.name + ' help <command>" for the options of a command.');
}

function globalParser(spec) {
	return ((new Optist())
			.opts(spec.globalOpts)
			.describeParam(0, 'command')
			.additional(1)
			.help(spec.name)
			.helpMessageHead(spec.description)
			.helpMessageTail(commandList(spec)));
}

function commandParser(spec, name) {
	const c = spec.commands[name];
	const p = (new Optist()).opts(c.opts || []);
	(c.params || []).forEach(function(x, i) {
		p.describeParam(i, x);
	});
	p.additional(c.min || 0, c.max);
	p.help(spec.name + ' [<global-opt> ...] ' + name);
	p.helpMessageHead(c.summary + '.');
	if (c.details) {
		p.helpMessageTail(c.details);
	}
	return p;
}

function fail(spec, message) {
	process.stderr.write(spec.name + ': ' + message + '\n');
	process.exit(1);
}

// spec: {
//   name, description,
//   globalOpts: [ optist option objects ],
//   requiredGlobals: [ { name, message } ]  checked for every command but help,
//   commands: { <name>: { summary, details, opts, params, min, max, run(ctx) } }
// }
// ctx passed to run: { global, opt, params, name }
// run may be async and may return an exit code (default 0). An Error
// thrown from run is printed as "<tool>: <message>" with exit code 1.
async function run(spec, argv) {
	const g = globalParser(spec).parse(Array.from(argv || process.argv.slice(2)));
	const rest = g.rest();
	const name = rest[0];
	if (name === 'help') {
		if (rest.length > 2) {
			fail(spec, 'help takes at most one command name');
		}
		if (rest.length === 2) {
			if (! Object.hasOwn(spec.commands, rest[1])) {
				fail(spec, 'unknown command ' + JSON.stringify(rest[1]) + '\n' + commandList(spec));
			}
			commandParser(spec, rest[1]).showHelpAndExit(0);
		}
		globalParser(spec).showHelpAndExit(0);
	}
	if (! Object.hasOwn(spec.commands, name)) {
		fail(spec, 'unknown command ' + JSON.stringify(name) + '\n' + commandList(spec));
	}
	const c = commandParser(spec, name).parse(rest.slice(1));
	for (const r of (spec.requiredGlobals || [])) {
		if (g.value(r.name) === undefined) {
			fail(spec, r.message);
		}
	}
	let code;
	try {
		code = await spec.commands[name].run({ global: g, opt: c, params: c.rest(), name: name });
	} catch (e) {
		fail(spec, e.message);
	}
	process.exitCode = (typeof(code) === 'number') ? code : 0;
}

// Option argument callbacks shared by the tools.

function secondsCbFactory(allowZero, max) {
	return function(s) {
		if (! /^[0-9]+(\.[0-9]+)?$/.test(s)) {
			return undefined;
		}
		const n = Number(s);
		if ((! Number.isFinite(n)) || (allowZero ? (n < 0) : (n <= 0)) || (n > max)) {
			return undefined;
		}
		return n;
	};
}

module.exports = {
	run,
	secondsCbFactory
};
