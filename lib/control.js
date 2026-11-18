'use strict';

// Control socket: a Unix domain socket speaking one line of JSON in
// each direction per connection.
//
//   request:  {"command": "<name>", "args": ["...", ...]}
//   response: {"ok": true, "result": <any>} or {"ok": false, "error": "<message>"}

const fs = require('node:fs');
const net = require('node:net');

const MAX_REQUEST = 65536;
const REQUEST_TIMEOUT_MS = 10000;

class ControlError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ControlError';
	}
}

function tryConnect(path) {
	return new Promise(function(resolve) {
		const s = net.connect(path);
		s.once('connect', function() {
			s.destroy();
			resolve(null);
		});
		s.once('error', function(e) {
			resolve(e);
		});
	});
}

// Make the path free for listening: a stale socket is removed, a live
// one (another daemon) or a non-socket file is an error.
async function preparePath(path) {
	let st;
	try {
		st = fs.lstatSync(path);
	} catch (e) {
		if (e.code === 'ENOENT') {
			return;
		}
		throw new ControlError('cannot access control socket ' + path + ': ' + e.message);
	}
	if (! st.isSocket()) {
		throw new ControlError('control socket path ' + path + ' exists and is not a socket');
	}
	const e = await tryConnect(path);
	if (e === null) {
		throw new ControlError('another daemon is listening on control socket ' + path);
	}
	if ((e.code !== 'ECONNREFUSED') && (e.code !== 'ENOENT')) {
		throw new ControlError('cannot check control socket ' + path + ': ' + e.message);
	}
	try {
		fs.unlinkSync(path);
	} catch (e2) {
		if (e2.code !== 'ENOENT') {
			throw new ControlError('cannot remove stale control socket ' + path + ': ' + e2.message);
		}
	}
}

function parseRequest(line) {
	let r;
	try {
		r = JSON.parse(line);
	} catch (e) {
		throw new ControlError('request is not valid JSON');
	}
	if (! ((typeof(r) === 'object') && (r !== null) && (! Array.isArray(r)))) {
		throw new ControlError('request must be a JSON object');
	}
	if (! ((typeof(r.command) === 'string') && (r.command !== ''))) {
		throw new ControlError('request has no command');
	}
	const args = (r.args === undefined) ? [] : r.args;
	if (! (Array.isArray(args) && args.every((a) => (typeof(a) === 'string')))) {
		throw new ControlError('request args must be an array of strings');
	}
	return { command: r.command, args: args };
}

// handler(request) returns a promise of the result, or of
// { result, after } where after() is called once the response has
// been written. Thrown errors become error responses. Only one command
// runs at a time; others get "busy".
class Server {
	constructor(path, handler) {
		this.path = path;
		this._handler = handler;
		this._busy = false;
		this._refusing = false;
		this._server = null;
		this._listening = false;
	}

	async listen() {
		await preparePath(this.path);
		this._server = net.createServer((s) => this._connection(s));
		const old = process.umask(0o177);
		try {
			await new Promise((resolve, reject) => {
				this._server.once('error', reject);
				this._server.listen(this.path, () => {
					this._server.removeListener('error', reject);
					resolve();
				});
			});
		} catch (e) {
			throw new ControlError('cannot listen on control socket ' + this.path + ': ' + e.message);
		} finally {
			process.umask(old);
		}
		this._listening = true;
		try {
			fs.chmodSync(this.path, 0o600);
		} catch (e) {
			/* umask already gave 0600 */
		}
	}

	_connection(s) {
		let buf = '', done = false;
		s.setEncoding('utf8');
		s.on('error', function() {});
		const reply = (response, after) => {
			if (done) {
				return;
			}
			done = true;
			clearTimeout(timer);
			s.end(JSON.stringify(response) + '\n', function() {
				if (after) {
					after();
				}
			});
		};
		const timer = setTimeout(function() {
			reply({ ok: false, error: 'request timed out' });
		}, REQUEST_TIMEOUT_MS);
		s.on('data', (d) => {
			if (done) {
				return;
			}
			buf += d;
			const i = buf.indexOf('\n');
			if (i < 0) {
				if (buf.length > MAX_REQUEST) {
					reply({ ok: false, error: 'request too large' });
				}
				return;
			}
			if (i > MAX_REQUEST) {
				reply({ ok: false, error: 'request too large' });
				return;
			}
			this._dispatch(buf.slice(0, i), reply);
		});
		s.on('end', function() {
			if (! done) {
				reply({ ok: false, error: 'incomplete request' });
			}
		});
		s.on('close', function() {
			clearTimeout(timer);
		});
	}

	_dispatch(line, reply) {
		let req;
		try {
			req = parseRequest(line);
		} catch (e) {
			reply({ ok: false, error: e.message });
			return;
		}
		if (this._busy || this._refusing) {
			reply({ ok: false, error: 'busy' });
			return;
		}
		this._busy = true;
		Promise.resolve().then(() => this._handler(req)).then((r) => {
			this._busy = false;
			if ((typeof(r) === 'object') && (r !== null) && Object.hasOwn(r, 'after')) {
				reply({ ok: true, result: (r.result === undefined) ? null : r.result }, r.after);
			} else {
				reply({ ok: true, result: (r === undefined) ? null : r });
			}
		}, (e) => {
			this._busy = false;
			reply({ ok: false, error: (e && e.message) ? e.message : String(e) });
		});
	}

	// Answer "busy" to every further command, e.g. during shutdown.
	refuse() {
		this._refusing = true;
	}

	close() {
		if (this._server !== null) {
			this._server.close();
			this._server = null;
		}
		if (this._listening) {
			this._listening = false;
			try {
				fs.unlinkSync(this.path);
			} catch (e) {
				/* already gone */
			}
		}
	}
}

// Send one request; resolves with the response object. Connection
// problems and timeouts reject with a ControlError.
function request(path, command, args, timeoutMs) {
	return new Promise(function(resolve, reject) {
		let buf = '', settled = false;
		const s = net.connect(path);
		const settle = function(err, value) {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			s.destroy();
			if (err) {
				reject(err);
			} else {
				resolve(value);
			}
		};
		const timer = setTimeout(function() {
			settle(new ControlError('no reply from the daemon within ' + (timeoutMs / 1000) + ' s'));
		}, timeoutMs);
		s.setEncoding('utf8');
		s.on('connect', function() {
			s.write(JSON.stringify({ command: command, args: args || [] }) + '\n');
		});
		s.on('data', function(d) {
			buf += d;
			const i = buf.indexOf('\n');
			if (i >= 0) {
				let r;
				try {
					r = JSON.parse(buf.slice(0, i));
				} catch (e) {
					settle(new ControlError('malformed reply from the daemon'));
					return;
				}
				settle(null, r);
			}
		});
		s.on('end', function() {
			settle(new ControlError('the daemon closed the connection without a reply'));
		});
		s.on('error', function(e) {
			let m;
			if (e.code === 'ENOENT') {
				m = 'no daemon at ' + path + ' (socket not found)';
			} else if (e.code === 'ECONNREFUSED') {
				m = 'no daemon listening at ' + path + ' (stale socket?)';
			} else {
				m = 'cannot connect to ' + path + ': ' + e.message;
			}
			settle(new ControlError(m));
		});
	});
}

module.exports = {
	MAX_REQUEST,
	REQUEST_TIMEOUT_MS,
	ControlError,
	preparePath,
	parseRequest,
	Server,
	request
};
