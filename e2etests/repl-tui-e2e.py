#!/usr/bin/env python3

import errno
import fcntl
import os
from pathlib import Path
import re
import select
import signal
import struct
import sys
import termios
import time


ROOT = Path(__file__).resolve().parents[1]
DLL = ROOT / "out/bin/Release/Repl/gsi.dll"
EXECUTABLE = os.environ.get("GSI_E2E_EXECUTABLE")
ALT_ON = b"\x1b[?1049h"
ALT_OFF = b"\x1b[?1049l"
ANSI_ESCAPE = re.compile(rb"\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))")


def strip_ansi(data):
    return ANSI_ESCAPE.sub(b"", bytes(data))


class Session:
    def __init__(self, args=None, extra_env=None):
        self.master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
        self.pid = os.fork()
        if self.pid == 0:
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            os.close(self.master)
            os.dup2(slave, 0)
            os.dup2(slave, 1)
            os.dup2(slave, 2)
            if slave > 2:
                os.close(slave)
            environment = os.environ.copy()
            environment["TERM"] = "xterm-256color"
            if extra_env:
                environment.update(extra_env)
            os.chdir(ROOT)
            cli_args = list(args) if args else []
            if EXECUTABLE:
                os.execvpe(EXECUTABLE, [EXECUTABLE] + cli_args, environment)
            os.execvpe("dotnet", ["dotnet", str(DLL)] + cli_args, environment)
        os.close(slave)
        fcntl.fcntl(self.master, fcntl.F_SETFL, os.O_NONBLOCK)
        self.output = bytearray()
        self.reaped = False

    def send(self, value):
        os.write(self.master, value)

    def resize(self, columns, rows):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    def pump(self, seconds):
        if seconds <= 0:
            return
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            remaining = end - time.monotonic()
            if remaining <= 0:
                break
            ready, _, _ = select.select([self.master], [], [], min(0.05, remaining))
            if not ready:
                continue
            try:
                chunk = os.read(self.master, 65536)
            except OSError as error:
                if error.errno in (errno.EAGAIN, errno.EIO):
                    continue
                raise
            if not chunk:
                break
            self.output.extend(chunk)

    def mark(self):
        return len(self.output)

    def expect(self, value, seconds=5.0, start=0):
        end = time.monotonic() + seconds
        while value not in strip_ansi(self.output[start:]) and time.monotonic() < end:
            self.pump(min(0.1, max(0.0, end - time.monotonic())))
        if value not in strip_ansi(self.output[start:]):
            words = re.findall(rb"[ -~]{4,}", strip_ansi(self.output[start:]))[-80:]
            raise RuntimeError(f"missing terminal text: {value!r}; strings={words!r}")

    def expect_raw(self, value, seconds=5.0, start=0):
        end = time.monotonic() + seconds
        while value not in self.output[start:] and time.monotonic() < end:
            self.pump(min(0.1, max(0.0, end - time.monotonic())))
        if value not in self.output[start:]:
            words = re.findall(rb"[ -~]{4,}", bytes(self.output[start:]))[-80:]
            raise RuntimeError(f"missing raw terminal output: {value!r}; strings={words!r}")

    def wait_exit(self, seconds=5.0):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            found, status = os.waitpid(self.pid, os.WNOHANG)
            if found == self.pid:
                self.reaped = True
                return status
            self.pump(0.05)
        raise RuntimeError("gsi did not exit")

    def close(self):
        if not self.reaped:
            found, _ = os.waitpid(self.pid, os.WNOHANG)
            if found != self.pid:
                os.kill(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
        os.close(self.master)


def run_sharptui_and_live_switch():
    session = Session()
    try:
        session.expect(b"session transcript")
        session.expect(b"editor [focus]")
        session.expect(b"focus: editor")
        session.expect(b"1 REPL")
        session.expect(b"6 Settings")
        start = session.mark()
        session.send(b"\t")
        session.expect(b"tabs ", start=start)
        session.expect(b"[1 REPL]", start=start)
        start = session.mark()
        session.send(b"\x1b[C")
        session.expect(b"[2 History]", start=start)
        start = session.mark()
        session.send(b"\x1b[C")
        session.expect(b"[3 Variables]", start=start)
        start = session.mark()
        session.send(b"\t")
        session.expect(b"[focus]", start=start)
        session.send(b"1")
        session.expect(b"editor ", start=start)
        session.send(b"1+2\r")
        session.expect(b"= 3", 10.0)
        session.expect(b"1+2")
        start = session.mark()
        session.send(b"Console.ReadLine()\r")
        session.expect(b"requested", 10.0, start)
        session.send(b"hello\r")
        session.expect(b'= "hello"', 10.0, start)
        start = session.mark()
        session.send(b"\x10")
        session.expect(b"command palette", start=start)
        session.expect(b"reset", start=start)
        session.expect(b"tree", start=start)
        session.send(b"\x1b")
        session.pump(0.15)
        start = session.mark()
        session.send(b"/")
        session.expect(b"search", start=start)
        start = session.mark()
        session.send(b"1+2")
        session.expect(b"1+2", start=start)
        session.send(b"\x1b")
        session.pump(0.15)
        start = session.mark()
        session.send(b"?")
        session.expect(b"Ctrl+Space", start=start)
        session.send(b"1")
        session.expect(b"transcript", start=start)
        session.resize(72, 22)
        session.pump(0.25)
        start = session.mark()
        session.send(b"let = 1")
        session.expect_raw(b"\x1b[4m", 5.0, start)
        if b"Unexpected" in strip_ansi(session.output[start:]):
            raise RuntimeError("live diagnostic leaked into a persistent editor banner")
        # Clear editor, restore wide size for Spectre's sidebar, then switch live to Spectre UI and back to SharpTUI.
        session.send(b"\x03")
        session.resize(100, 30)
        session.pump(0.15)
        start = session.mark()
        session.send(b":ui spectre\r")
        session.expect(b"STATE", 10.0, start)
        session.expect(b"cells 2", 5.0, start)
        # Verify Spectre receives single keystrokes immediately (non-canonical, no-echo)
        # without waiting for Enter.
        start = session.mark()
        session.send(b"z")
        session.expect_raw(b"\x1b[?2026h", 5.0, start)
        session.send(b"\x7f")
        session.pump(0.1)
        start = session.mark()
        session.send(b":ui sharptui\r")
        session.expect(b"session transcript", 10.0, start)
        session.expect(b"= 3", 5.0, start)
        # Verify a second SharpTUI -> Spectre switch also preserves non-canonical input.
        start = session.mark()
        session.send(b":ui spectre\r")
        session.expect(b"STATE", 10.0, start)
        start = session.mark()
        session.send(b"q")
        session.expect_raw(b"\x1b[?2026h", 5.0, start)
        session.send(b"\x7f")
        session.pump(0.1)
        start = session.mark()
        session.send(b":ui sharptui\r")
        session.expect(b"session transcript", 10.0, start)
        session.send(b"\x03\x03")
        status = session.wait_exit()
        session.pump(0.1)
        if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
            raise RuntimeError(f"gsi exited with status {status}")
        if ALT_ON not in session.output or ALT_OFF not in session.output:
            raise RuntimeError("gsi did not enter and restore the alternate screen")
    finally:
        session.close()


def run_spectre_flag_mode():
    session = Session(args=["--ui", "spectre"])
    try:
        session.expect(b"STATE", 10.0)
        session.send(b"1+2\r")
        session.expect(b"3", 10.0)
        session.send(b":exit\r")
        status = session.wait_exit()
        session.pump(0.1)
        if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
            raise RuntimeError(f"gsi --ui spectre exited with status {status}")
    finally:
        session.close()


def run():
    if not EXECUTABLE and not DLL.is_file():
        raise FileNotFoundError(f"build Release first: {DLL}")
    if EXECUTABLE and not Path(EXECUTABLE).is_file():
        raise FileNotFoundError(EXECUTABLE)
    run_sharptui_and_live_switch()
    run_spectre_flag_mode()


if __name__ == "__main__":
    try:
        run()
        print("repl TUI E2E: ok")
    except Exception as error:
        print(f"repl TUI E2E FAILED: {error}", file=sys.stderr)
        sys.exit(1)
