'use strict';

// A scriptable child program for the daemon tests. Each argument is a
// step, run in order:
//
//   out:<text>       print a line to stdout
//   err:<text>       print a line to stderr
//   partial:<text>   print to stdout without a newline
//   env:<NAME>       print NAME=<value>, or NAME is unset
//   cwd              print cwd=<dir>
//   pid              print pid=<pid>
//   count:<file>     append a line to file (counts starts)
//   sleep:<ms>       wait
//   stdin            echo stdin lines as in:<line> until EOF, then stdin-eof
//   ignore-term      print got SIGTERM on SIGTERM, but keep running
//   term-exit        print got SIGTERM on SIGTERM and exit 0
//   forever          keep running
//   exit:<code>      exit with code
//   kill:<SIGNAL>    kill itself with a signal

const fs = require('node:fs');

const steps = process.argv.slice(2);

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function readStdin() {
	return new Promise(function(resolve) {
		let buf = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', function(d) {
			buf += d;
			let i;
			while ((i = buf.indexOf('\n')) >= 0) {
				process.stdout.write('in:' + buf.slice(0, i) + '\n');
				buf = buf.slice(i + 1);
			}
		});
		process.stdin.on('end', function() {
			if (buf !== '') {
				process.stdout.write('in:' + buf + '\n');
			}
			process.stdout.write('stdin-eof\n');
			resolve();
		});
	});
}

async function main() {
	for (const s of steps) {
		const i = s.indexOf(':');
		const op = (i >= 0) ? s.slice(0, i) : s;
		const arg = (i >= 0) ? s.slice(i + 1) : '';
		switch (op) {
		case 'out':
			process.stdout.write(arg + '\n');
			break;
		case 'err':
			process.stderr.write(arg + '\n');
			break;
		case 'partial':
			process.stdout.write(arg);
			break;
		case 'env':
			process.stdout.write((Object.hasOwn(process.env, arg) ? (arg + '=' + process.env[arg]) : (arg + ' is unset')) + '\n');
			break;
		case 'cwd':
			process.stdout.write('cwd=' + process.cwd() + '\n');
			break;
		case 'pid':
			process.stdout.write('pid=' + process.pid + '\n');
			break;
		case 'count':
			fs.appendFileSync(arg, 'x\n');
			break;
		case 'sleep':
			await sleep(Number(arg));
			break;
		case 'stdin':
			await readStdin();
			break;
		case 'ignore-term':
			process.on('SIGTERM', () => process.stdout.write('got SIGTERM\n'));
			break;
		case 'term-exit':
			process.on('SIGTERM', function() {
				process.stdout.write('got SIGTERM\n', () => process.exit(0));
			});
			break;
		case 'forever':
			setInterval(function() {}, 1000000);
			await new Promise(function() {});
			break;
		case 'exit':
			await new Promise((r) => process.stdout.write('', r));
			process.exit(Number(arg));
			break;
		case 'kill':
			process.kill(process.pid, arg);
			await sleep(1000);
			break;
		default:
			process.stderr.write('prog.js: unknown step ' + s + '\n');
			process.exit(99);
		}
	}
}

main();
