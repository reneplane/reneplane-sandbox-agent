import * as pty from '@lydell/node-pty';
import type { Env } from '../util/process.js';

/** Real terminals in the mission folder: PowerShell on Windows, the learner's shell elsewhere */
export class Terminals {
  private nextId = 1;
  private readonly sessions = new Map<number, pty.IPty>();

  open(
    size: { cols: number; rows: number },
    cwd: string,
    env: Env,
    onData: (termId: number, data: string) => void,
    onExit: (termId: number, code: number) => void,
  ): number {
    const id = this.nextId++;
    const windows = process.platform === 'win32';
    const shell = windows ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash');
    // Not a login shell: a login profile would put /usr/bin first again (and on macOS, its git)
    const args = windows ? ['-NoLogo'] : ['-i'];
    const terminal = pty.spawn(shell, args, { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd, env });
    terminal.onData((data) => onData(id, data));
    terminal.onExit(({ exitCode }) => {
      this.sessions.delete(id);
      onExit(id, exitCode);
    });
    this.sessions.set(id, terminal);
    return id;
  }

  input(id: number, data: string): void {
    this.sessions.get(id)?.write(data);
  }

  resize(id: number, cols: number, rows: number): void {
    try {
      this.sessions.get(id)?.resize(cols, rows);
    } catch {
      // resizing a terminal that is exiting
    }
  }

  close(id: number): void {
    const terminal = this.sessions.get(id);
    this.sessions.delete(id);
    try {
      terminal?.kill();
    } catch {
      // already gone
    }
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
