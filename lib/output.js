'use strict';

// Output handling: splitting program output into lines, formatting
// them with a name prefix and timestamp, and writing them to stdout or
// to a log file that can be reopened for rotation.

const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');

const DAEMON_NAME = '@daemon';
const MAX_LINE = 65536;

// Feeds bytes in, emits complete lines (without the line terminator)
// through onLine. UTF-8 sequences split across chunks are handled,
// invalid bytes become U+FFFD, a trailing \r is stripped, and lines
// longer than maxLine characters are emitted in pieces.
class LineSplitter {
	constructor(onLine, maxLine) {
		this._onLine = onLine;
		this._max = maxLine || MAX_LINE;
		this._decoder = new StringDecoder('utf8');
		this._buf = '';
		this._ended = false;
	}

	push(chunk) {
		if (this._ended) {
			throw new Error('push after end');
		}
		this._take((typeof(chunk) === 'string') ? chunk : this._decoder.write(chunk));
	}

	end() {
		if (this._ended) {
			return;
		}
		this._take(this._decoder.end());
		this._ended = true;
		if (this._buf !== '') {
			this._emit(this._buf);
			this._buf = '';
		}
	}

	_take(s) {
		if (s === '') {
			return;
		}
		let b = this._buf + s;
		let i;
		while ((i = b.indexOf('\n')) >= 0) {
			this._emit(b.slice(0, i));
			b = b.slice(i + 1);
		}
		// Keep the incomplete tail bounded. One extra character is held
		// back so that a \r right before the limit can still pair with a
		// following \n.
		while (b.length > this._max + 1) {
			let cut = this._max;
			if (isHighSurrogate(b.charCodeAt(cut - 1))) {
				cut--;
			}
			this._onLine(b.slice(0, cut));
			b = b.slice(cut);
		}
		this._buf = b;
	}

	_emit(line) {
		if (line.endsWith('\r')) {
			line = line.slice(0, -1);
		}
		while (line.length > this._max) {
			let cut = this._max;
			if (isHighSurrogate(line.charCodeAt(cut - 1))) {
				cut--;
			}
			this._onLine(line.slice(0, cut));
			line = line.slice(cut);
		}
		this._onLine(line);
	}
}

function isHighSurrogate(c) {
	return ((c >= 0xd800) && (c <= 0xdbff));
}

function formatLine(name, width, isErr, timestamp, text) {
	return name.padEnd(width) + (isErr ? ' ! ' : ' | ') + timestamp + ' ' + text + '\n';
}

// Writes to process.stdout, or appends to a file. reopen() swaps in a
// freshly opened file (after rotation); close() flushes.
class Sink {
	constructor(file) {
		this._file = file || null;
		this._stream = null;
		this._retiring = [];
		if (this._file !== null) {
			this._stream = this._open();
		} else {
			this._stream = process.stdout;
			// A closed stdout (EPIPE) must not take the daemon down.
			process.stdout.on('error', function() {});
		}
	}

	get file() {
		return this._file;
	}

	_open() {
		const fd = fs.openSync(this._file, 'a', 0o644);
		const s = fs.createWriteStream(this._file, { fd: fd, flags: 'a' });
		s.on('error', function() {});
		return s;
	}

	write(s) {
		this._stream.write(s);
	}

	// Returns null on success, or the error if the file could not be
	// opened; then the old file stays in use.
	reopen() {
		if (this._file === null) {
			return null;
		}
		let s;
		try {
			s = this._open();
		} catch (e) {
			return e;
		}
		const old = this._stream;
		this._stream = s;
		this._retiring.push(new Promise((resolve) => old.end(resolve)));
		return null;
	}

	// Resolves when everything written so far, including to files
	// replaced by reopen(), has been flushed.
	close() {
		const s = this._stream;
		const done = new Promise(function(resolve) {
			if (s === process.stdout) {
				s.write('', function() { resolve(); });
			} else {
				s.end(function() { resolve(); });
			}
		});
		return Promise.all(this._retiring.concat([ done ])).then(function() {});
	}
}

// Formats and writes lines. The name column is as wide as the longest
// program name, counting @daemon.
class Output {
	constructor(sink, names, clock) {
		this._sink = sink;
		this._clock = clock || function() { return new Date().toISOString(); };
		this.setNames(names || []);
	}

	setNames(names) {
		this._width = Math.max(DAEMON_NAME.length, ...names.map((n) => n.length));
	}

	line(name, isErr, text) {
		this._sink.write(formatLine(name, this._width, isErr, this._clock(), text));
	}

	daemon(text, isErr) {
		this.line(DAEMON_NAME, !! isErr, text);
	}

	// A LineSplitter that writes each line of a program stream.
	splitter(name, isErr) {
		return new LineSplitter((text) => this.line(name, isErr, text));
	}

	reopen() {
		return this._sink.reopen();
	}

	close() {
		return this._sink.close();
	}
}

module.exports = {
	DAEMON_NAME,
	MAX_LINE,
	LineSplitter,
	formatLine,
	Sink,
	Output
};
