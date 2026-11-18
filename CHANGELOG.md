Changelog
=========

0.1.0
-----

First release. Requires Node.js 24 or newer.

- `tr-cli-daemon` runs the programs listed in a JSON config file in
  their own process groups.
  - Restart policies are `auto`, `on-failure` and `never`, with a
    configurable delay.
  - Each program can have its own `cwd` and `env` (where `null`
    removes a variable), a text written to stdin with the option to
    close stdin afterwards, and discarded stdout or stderr.
  - Output is printed with the name, a stdout/stderr marker and a
    timestamp, to stdout or to an appended log file that SIGHUP
    reopens.
  - SIGTERM and SIGINT stop all programs: first SIGTERM, then SIGKILL
    after `killTimeout`. A second signal sends SIGKILL at once.
- `tr-cli-daemon-config` creates and edits the config file with
  `create-config`, `add-program`, `modify-program`, `remove-program`,
  `modify-global` and `show`. Every change is validated and written
  atomically.
- With `--control-socket`, the daemon accepts `restart` (of all or the
  named programs, after reloading the config), `quit` and `status`
  from `tr-cli-daemon-ctl` over a Unix socket.
- The config file, log file and control socket can also be given with
  the `TR_CLI_DAEMON_CONFIG`, `TR_CLI_DAEMON_LOGFILE` and
  `TR_CLI_DAEMON_CONTROL_SOCKET` environment variables.
