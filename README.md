tr-cli-daemon
=============

Keep a set of command line programs running.

The targets are programs that are started from the command line, stay
in the foreground and print to stdout and stderr. tr-cli-daemon starts
them, restarts them when they exit, and prints their output with the
program name and a timestamp, much like `docker compose logs
--timestamps --follow`.

The package has three executables:

- `tr-cli-daemon`, the daemon itself.
- `tr-cli-daemon-config`, which creates and edits the JSON config file.
- `tr-cli-daemon-ctl`, which sends commands (`restart`, `quit`,
  `status`) to a running daemon over its control socket.

It requires Node.js 20 or newer. The only dependency is
[optist](https://www.npmjs.com/package/optist).


Quick start
===========

```
npm install -g tr-cli-daemon

tr-cli-daemon-config -c daemon.json create-config
tr-cli-daemon-config -c daemon.json add-program web /usr/local/bin/web-server --port 8080
tr-cli-daemon-config -c daemon.json add-program --restart=on-failure --restart-delay=60 \
    sync /usr/local/bin/sync-thing --verbose

tr-cli-daemon -c daemon.json
```

```
@daemon | 2026-11-18T14:12:00.120Z starting tr-cli-daemon 0.1.0, pid 4711, config /home/me/daemon.json
@daemon | 2026-11-18T14:12:00.122Z web started, pid 4712
@daemon | 2026-11-18T14:12:00.123Z sync started, pid 4713
web     | 2026-11-18T14:12:00.301Z listening on port 8080
sync    ! 2026-11-18T14:12:01.002Z cannot reach upstream
@daemon ! 2026-11-18T14:12:01.010Z sync exited with code 1, restarting in 60 s
```

Stop it with ^C. All programs are stopped before the daemon exits.

About npx: `npx tr-cli-daemon` works without installing anything, but
npx looks up any other command as a package name. If the package is
not installed, run the other two tools like this:

```
npx -p tr-cli-daemon tr-cli-daemon-config ...
npx -p tr-cli-daemon tr-cli-daemon-ctl ...
```


The daemon
==========

```
tr-cli-daemon --config=<file> [--logfile=<file>] [--control-socket=<path>]
```

| option                          | environment                    | meaning |
|---------------------------------|--------------------------------|---------|
| `-c`, `--config=<file>`         | `TR_CLI_DAEMON_CONFIG`         | Config file. Required. |
| `-l`, `--logfile=<file>`        | `TR_CLI_DAEMON_LOGFILE`        | Append the output to this file instead of stdout. |
| `-s`, `--control-socket=<path>` | `TR_CLI_DAEMON_CONTROL_SOCKET` | Listen for `tr-cli-daemon-ctl` commands on this Unix socket. No socket is opened without it. |
| `-h`, `--help`                  |                                | Show help. |

A command line option takes precedence over its environment variable.

At startup the daemon reads and validates the config. If anything is
wrong, it prints every problem to stderr and exits with code 1 before
starting any program. Then it starts every enabled program.

The daemon runs in the foreground. Use nohup, tmux, systemd, launchd
or similar to run it in the background.

When no program is running or waiting to be restarted, the daemon
exits with code 0. With a control socket it stays up instead, waiting
for commands.

Signals:

| signal             | effect |
|--------------------|--------|
| SIGTERM, SIGINT    | Stop all programs and exit 0. A second one during the shutdown sends SIGKILL to all programs at once. |
| SIGHUP             | Reopen the log file, for log rotation. |

Each program runs in its own process group. Signals from the daemon go
to the whole group, so the children of wrapper scripts are stopped
too, and a ^C in the terminal reaches only the daemon. To stop a
program, the daemon sends SIGTERM to its group and waits up to
`killTimeout` seconds, then sends SIGKILL.


Output
======

Every line a program prints becomes one output line:

```
<name> | <timestamp> <line from stdout>
<name> ! <timestamp> <line from stderr>
```

- The name column is padded to the longest program name.
- The timestamp is ISO 8601 UTC with milliseconds, taken when the line
  was received.
- The daemon's own messages appear under the name `@daemon`, and its
  failure messages are marked with `!`.
- Output is decoded as UTF-8, invalid bytes becoming U+FFFD, and a
  trailing `\r` is removed.
- A last line without a newline is still printed.
- Lines longer than 64 KiB are split.

With `--logfile` nothing goes to stdout. After rotating the file, send
the daemon a SIGHUP to make it open a new one.

The daemon always reads the programs' output, even output that is
discarded, so a program never blocks on a full pipe.


Config file
===========

The config file is strict JSON. Keys that aren't listed below are
errors, so typos are caught.

```json
{
  "global": {
    "restart": "auto",
    "restartDelay": 10,
    "killTimeout": 10
  },
  "programs": {
    "web": {
      "cmd": ["/usr/local/bin/web-server", "--port", "8080"]
    },
    "sync": {
      "cmd": ["/usr/local/bin/sync-thing", "--verbose"],
      "enabled": true,
      "restart": "on-failure",
      "restartDelay": 60,
      "cwd": "data",
      "env": { "LANG": "C", "HTTP_PROXY": null },
      "stdin": "username\npassword\n",
      "closeStdin": true,
      "discardStdout": false,
      "discardStderr": false
    }
  }
}
```

`global` is optional and holds defaults:

| key            | default  | meaning |
|----------------|----------|---------|
| `restart`      | `"auto"` | Default restart policy. |
| `restartDelay` | `10`     | Default number of seconds to wait before a restart. 0 or more. |
| `killTimeout`  | `10`     | Seconds between SIGTERM and SIGKILL when stopping a program. More than 0. |

Program names may contain letters, digits, `.`, `_` and `-`. They must
start with a letter or a digit and be at most 64 characters long.

Program keys:

| key             | default        | meaning |
|-----------------|----------------|---------|
| `cmd`           | required       | The command line as an array. `cmd[0]` is looked up in `PATH`. No shell is involved. |
| `enabled`       | `true`         | Disabled programs are not started. |
| `restart`       | global         | `"auto"`: restart after any exit. `"on-failure"`: restart after a non-zero exit code, a death by signal or a failure to start. `"never"`: don't restart. |
| `restartDelay`  | global         | Seconds to wait before a restart. |
| `cwd`           | daemon's cwd   | Working directory. A relative path is relative to the directory of the config file. |
| `env`           | `{}`           | Variables added to the daemon's environment. A `null` value removes the variable. |
| `stdin`         | `""`           | Text written to the program's stdin each time it starts. |
| `closeStdin`    | `false`        | Close stdin after writing `stdin`. Otherwise stdin stays open but idle. |
| `discardStdout` | `false`        | Read stdout but don't print it. |
| `discardStderr` | `false`        | Read stderr but don't print it. |

Values given in seconds may be fractional and can be at most 1000000.


Editing the config: tr-cli-daemon-config
========================================

```
tr-cli-daemon-config --config=<file> <command> [<command-option> ...] [<param> ...]
```

`--config` (`-c`) can also be given with `TR_CLI_DAEMON_CONFIG`, the
same variable the daemon reads. Run `tr-cli-daemon-config help
<command>` to see the options of a command.

The command line of the program comes last. Anything after `<cmd>`
belongs to the program, so its own options don't need quoting or a
`--`:

```
tr-cli-daemon-config -c d.json add-program --restart-delay=5 web /usr/bin/web --port 80 -v
```

Every change is validated before it is written, and the file is
replaced atomically. A failed command leaves the file as it was. A
running daemon doesn't notice changes by itself; apply them with
`tr-cli-daemon-ctl restart`.

Commands:

- `create-config [--force]`: write a config with no programs. An
  existing file is overwritten only with `--force`.
- `add-program [<option> ...] <name> <cmd> [<arg> ...]`. Options:
  - `--disabled`
  - `--restart=auto|on-failure|never`
  - `--restart-delay=<seconds>`
  - `--cwd=<dir>`
  - `--env=NAME=VALUE` (repeatable)
  - `--unset-env=NAME` (repeatable; stores `null`)
  - `--stdin=<text>`, or `--stdin-file=<file>` to read the text from a
    file
  - `--close-stdin`
  - `--discard-stdout`
  - `--discard-stderr`
- `modify-program [<option> ...] <name> [<cmd> [<arg> ...]]`: change a
  program. A command line given after the name replaces `cmd`. Options:
  - The `add-program` options, except `--disabled`.
  - `--enable` / `--disable`
  - `--close-stdin` / `--no-close-stdin`
  - `--discard-stdout` / `--no-discard-stdout`
  - `--discard-stderr` / `--no-discard-stderr`
  - `--remove-env=NAME`: delete an `env` entry (repeatable).
  - `--reset=<key>`: remove `restart`, `restartDelay`, `cwd`, `env` or
    `stdin`, so the default applies again (repeatable).
  - `--rename=<new-name>`
- `remove-program <name>`
- `modify-global [<option> ...]`. Options:
  - `--restart=<policy>`
  - `--restart-delay=<seconds>`
  - `--kill-timeout=<seconds>`
  - `--reset=restart|restartDelay|killTimeout`
- `show [<name>]`: print the config, or one program, as JSON.


Controlling a running daemon: tr-cli-daemon-ctl
===============================================

Start the daemon with a control socket:

```
tr-cli-daemon -c daemon.json --control-socket=/run/user/1000/tr-cli-daemon.sock
```

```
tr-cli-daemon-ctl --control-socket=<path> [--timeout=<seconds>] [--json] <command> [<param> ...]
```

| option                          | environment                    | meaning |
|---------------------------------|--------------------------------|---------|
| `-s`, `--control-socket=<path>` | `TR_CLI_DAEMON_CONTROL_SOCKET` | Socket of the daemon. Required. |
| `--timeout=<seconds>`           | `TR_CLI_DAEMON_TIMEOUT`        | How long to wait for the reply. Default 60. |
| `--json`                        |                                | Print the raw JSON reply. |

Commands:

- `restart`: read the config file again, stop all programs, and start
  every enabled one. If the new config is invalid, the error is
  reported and nothing changes.
- `restart <name> ...`: read the config file again, but restart only
  the named programs. The others keep running and pick up their new
  settings the next time they restart. A program removed from the
  config keeps running until it is named here or exits by itself;
  either way it is then not started again.
- `quit`: stop all programs and the daemon. It returns once everything
  has stopped.
- `status`: show each program's state (`running`, `waiting` for a
  restart, `stopping` or `stopped`), pid, time of the last state
  change, number of restarts and last exit.

```
$ tr-cli-daemon-ctl -s /run/user/1000/tr-cli-daemon.sock status
NAME  STATE    PID   SINCE                     RESTARTS  LAST EXIT
web   running  4712  2026-11-18T14:12:00.122Z  0         -
sync  waiting  -     2026-11-18T14:12:01.010Z  0         code 1
```

The exit code is 0 on success and 1 if the daemon reports an error,
can't be reached, or doesn't answer in time.

The socket is created with mode 0600, and file permissions are the
only access control. If the socket is left over from a daemon that
died, it is removed at startup. If another daemon is still listening
on it, the new daemon refuses to start. The socket is removed when the
daemon exits.

The protocol is one request per connection, with one line of JSON in
each direction:

```
-> {"command": "restart", "args": ["web"]}
<- {"ok": true, "result": [{"name": "web", "action": "restarted"}]}
```

Only one command runs at a time. Commands that arrive meanwhile, or
during shutdown, get `{"ok": false, "error": "busy"}`.


Author
======

Timo J. Rinne <tri@iki.fi>


License
=======

MIT License
