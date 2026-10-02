#!/usr/bin/env python3
"""Own only the launched CLI's PTY; relay native I/O and one scoped Escape.

No TIOCSTI, process-kill Stop, foreground-window input, or shell evaluation.
Closing the user's terminal closes this PTY as it would a normal CLI.
"""
import errno
import fcntl
import json
import os
import pty
import secrets
import selectors
import signal
import socket
import struct
import sys
import tempfile
import termios
import time
import tty


def identity(pid):
    with open('/proc/%d/stat' % pid, encoding='utf8') as stream:
        fields = stream.read().rsplit(')', 1)[1].split()
    return fields[19]  # field 22, start time in kernel ticks


def read_json(path):
    with open(path, encoding='utf8') as stream:
        data = stream.read(512001)
    if len(data) > 512000:
        raise ValueError('Snapshot too large')
    return json.loads(data)


def main():
    run, *command = sys.argv[1:]
    if not command:
        raise ValueError('Missing CLI command')
    os.umask(0o077)
    temporary = tempfile.mkdtemp(prefix='even-pilot-pty-')
    address = os.path.join(temporary, 'control.sock')
    server = socket.socket(socket.AF_UNIX)
    server.bind(address)
    server.listen(4)
    server.setblocking(False)
    token = secrets.token_hex(32)
    original = termios.tcgetattr(0) if os.isatty(0) else None
    pid, master = pty.fork()
    if pid == 0:
        server.close()
        os.execvpe(command[0], command, os.environ)
    started = identity(pid)
    owner = dict(pid=pid, started=started, socket=address, token=token)
    path = os.path.join(run, 'owner.json')
    with open(path + '.tmp', 'x', encoding='utf8') as stream:
        json.dump(owner, stream)
    os.replace(path + '.tmp', path)
    selector = selectors.DefaultSelector()
    selector.register(master, selectors.EVENT_READ, 'output')
    selector.register(server, selectors.EVENT_READ, 'control')
    selector.register(0, selectors.EVENT_READ, 'input')
    sent = set()

    def resize(*_):
        if os.isatty(0):
            fcntl.ioctl(master, termios.TIOCSWINSZ, fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8))

    def close_terminal(*_):
        raise SystemExit(0)

    signal.signal(signal.SIGWINCH, resize)
    signal.signal(signal.SIGHUP, close_terminal)
    signal.signal(signal.SIGTERM, close_terminal)
    resize()
    try:
        if original is not None:
            tty.setraw(0)
        while True:
            for key, _ in selector.select(0.2):
                if key.data == 'control':
                    client, _ = server.accept()
                    with client:
                        client.settimeout(0.3)
                        try:
                            _, uid, _ = struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                            if uid != os.getuid():
                                raise ValueError('Wrong owner')
                            payload = b''
                            while b'\n' not in payload and len(payload) <= 4096:
                                part = client.recv(4096)
                                if not part:
                                    break
                                payload += part
                            request = json.loads(payload)
                            now = int(time.time() * 1000)
                            if not secrets.compare_digest(request.get('token', ''), token) or not now <= request['deadline'] <= now + 3000:
                                raise ValueError('Invalid request')
                            snapshot = read_json(request['snapshot'])
                            run_key = (request['instance'], request['key'], request['runId'])
                            if (identity(pid) != started or snapshot['terminalPid'] != pid or snapshot['instance'] != request['instance']
                                or snapshot['state']['session']['key'] != request['key'] or snapshot['runId'] != request['runId']
                                or not 0 <= now - snapshot['at'] < 5000 or not snapshot['state']['connected']
                                or snapshot['state']['main']['status'] not in ('running', 'waiting') or run_key in sent):
                                raise ValueError('Stale or repeated Stop')
                            # Delivery is acknowledged, not task completion. The channel
                            # waits for the native transcript's interruption event.
                            sent.add(run_key)
                            if len(sent) > 512:
                                sent = {run_key}
                            os.write(master, b'\x1b')
                            client.sendall(b'{"ok":true}\n')
                        except (OSError, ValueError, KeyError, TypeError):
                            try:
                                client.sendall(b'{"ok":false}\n')
                            except OSError:
                                pass
                else:
                    try:
                        data = os.read(key.fd, 65536)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            data = b''
                        else:
                            raise
                    if not data:
                        return
                    destination = 1 if key.data == 'output' else master
                    while data:
                        data = data[os.write(destination, data):]
            exited, status = os.waitpid(pid, os.WNOHANG)
            if exited:
                return os.waitstatus_to_exitcode(status)
    finally:
        if original is not None:
            termios.tcsetattr(0, termios.TCSADRAIN, original)
        selector.close()
        server.close()
        os.close(master)
        os.unlink(address)
        os.rmdir(temporary)


if __name__ == '__main__':
    sys.exit(main() or 0)
