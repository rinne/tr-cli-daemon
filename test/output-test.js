'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const output = require('../lib/output.js');

function split(chunks, max) {
	const lines = [];
	const s = new output.LineSplitter((l) => lines.push(l), max);
	for (const c of chunks) {
		s.push((typeof(c) === 'string') ? Buffer.from(c, 'utf8') : c);
	}
	s.end();
	return lines;
}

describe('LineSplitter', function() {
	it('splits on newlines', function() {
		assert.deepEqual(split([ 'a\nb\n' ]), [ 'a', 'b' ]);
	});

	it('keeps empty lines', function() {
		assert.deepEqual(split([ '\n\na\n\n' ]), [ '', '', 'a', '' ]);
	});

	it('joins lines across chunks', function() {
		assert.deepEqual(split([ 'ab', 'c\nd', 'e', '\n' ]), [ 'abc', 'de' ]);
	});

	it('flushes a partial last line at end', function() {
		assert.deepEqual(split([ 'a\nlast' ]), [ 'a', 'last' ]);
		assert.deepEqual(split([]), []);
		assert.deepEqual(split([ '' ]), []);
	});

	it('strips a trailing carriage return only', function() {
		assert.deepEqual(split([ 'a\r\nb\r', '\nc\rd\n', 'e\r' ]), [ 'a', 'b', 'c\rd', 'e' ]);
	});

	it('decodes UTF-8 split across chunks', function() {
		const b = Buffer.from('ä€😀\n', 'utf8');
		const chunks = [];
		for (let i = 0; i < b.length; i++) {
			chunks.push(b.subarray(i, i + 1));
		}
		assert.deepEqual(split(chunks), [ 'ä€😀' ]);
	});

	it('replaces invalid bytes', function() {
		assert.deepEqual(split([ Buffer.from([ 0x61, 0xff, 0x62, 0x0a ]) ]), [ 'a\ufffdb' ]);
		assert.deepEqual(split([ Buffer.from([ 0x61, 0xe2, 0x82 ]) ]), [ 'a\ufffd' ]);
	});

	it('splits long lines', function() {
		assert.deepEqual(split([ 'abcdefghij\n' ], 4), [ 'abcd', 'efgh', 'ij' ]);
		assert.deepEqual(split([ 'abcd\n' ], 4), [ 'abcd' ]);
		assert.deepEqual(split([ 'abcd\r\n' ], 4), [ 'abcd' ]);
		assert.deepEqual(split([ 'ab', 'cd', 'ef', 'gh', 'ij' ], 4), [ 'abcd', 'efgh', 'ij' ]);
	});

	it('bounds an unterminated line while it grows', function() {
		const lines = [];
		const s = new output.LineSplitter((l) => lines.push(l), 4);
		s.push(Buffer.from('abcdefghijk'));
		assert.deepEqual(lines, [ 'abcd', 'efgh' ]);
		s.end();
		assert.deepEqual(lines, [ 'abcd', 'efgh', 'ijk' ]);
	});

	it('does not split surrogate pairs', function() {
		assert.deepEqual(split([ 'abc😀d\n' ], 4), [ 'abc', '😀d' ]);
	});

	it('uses 64 KiB as the default limit', function() {
		const long = 'x'.repeat(output.MAX_LINE + 10);
		assert.deepEqual(split([ long + '\n' ]).map((l) => l.length), [ output.MAX_LINE, 10 ]);
	});
});

describe('formatLine', function() {
	it('formats stdout and stderr lines', function() {
		assert.equal(output.formatLine('prog1', 9, false, 'T', 'hello'), 'prog1     | T hello\n');
		assert.equal(output.formatLine('prog1', 9, true, 'T', 'oops'), 'prog1     ! T oops\n');
	});
});

describe('Output', function() {
	function collect() {
		const lines = [];
		return { lines: lines, sink: { write: (s) => lines.push(s), reopen: () => null, close: () => Promise.resolve() } };
	}

	it('pads to the longest name including @daemon', function() {
		const c = collect();
		const o = new output.Output(c.sink, [ 'a', 'bb' ], () => 'T');
		o.line('a', false, 'x');
		o.daemon('started');
		o.daemon('failed', true);
		assert.deepEqual(c.lines, [ 'a       | T x\n', '@daemon | T started\n', '@daemon ! T failed\n' ]);
		o.setNames([ 'a-much-longer-name' ]);
		o.line('a', true, 'y');
		assert.deepEqual(c.lines[3], 'a                  ! T y\n');
	});

	it('timestamps with ISO 8601 UTC milliseconds by default', function() {
		const c = collect();
		const o = new output.Output(c.sink, []);
		o.daemon('x');
		assert.match(c.lines[0], /^@daemon \| \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z x\n$/);
	});

	it('provides splitters bound to a program stream', function() {
		const c = collect();
		const o = new output.Output(c.sink, [ 'p' ], () => 'T');
		const s = o.splitter('p', true);
		s.push(Buffer.from('one\ntw'));
		s.push(Buffer.from('o'));
		s.end();
		assert.deepEqual(c.lines, [ 'p       ! T one\n', 'p       ! T two\n' ]);
	});
});

describe('Sink', function() {
	let dir;
	beforeEach(function() {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-cli-daemon-output-test-'));
	});
	afterEach(function() {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('appends to a file', async function() {
		const file = path.join(dir, 'log');
		fs.writeFileSync(file, 'old\n');
		const s = new output.Sink(file);
		s.write('new\n');
		await s.close();
		assert.equal(fs.readFileSync(file, 'utf8'), 'old\nnew\n');
	});

	it('reopens after rotation', async function() {
		const file = path.join(dir, 'log');
		const s = new output.Sink(file);
		s.write('one\n');
		fs.renameSync(file, file + '.1');
		s.write('two\n');
		assert.equal(s.reopen(), null);
		s.write('three\n');
		await s.close();
		assert.equal(fs.readFileSync(file + '.1', 'utf8'), 'one\ntwo\n');
		assert.equal(fs.readFileSync(file, 'utf8'), 'three\n');
	});

	it('keeps the old file when reopening fails', async function() {
		const sub = path.join(dir, 'sub');
		fs.mkdirSync(sub);
		const file = path.join(sub, 'log');
		const s = new output.Sink(file);
		s.write('one\n');
		fs.renameSync(sub, sub + '.moved');
		const e = s.reopen();
		assert.ok(e instanceof Error);
		s.write('two\n');
		await s.close();
		assert.equal(fs.readFileSync(path.join(sub + '.moved', 'log'), 'utf8'), 'one\ntwo\n');
	});

	it('fails at once if the file cannot be opened', function() {
		assert.throws(() => new output.Sink(path.join(dir, 'no', 'such', 'dir', 'log')), /ENOENT/);
	});
});
