import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import type { SpawnFn } from './vmTarget';

// A stand-in for the `ssh` the dev VM code spawns: records each call and
// answers from `respond`, so the tests never need a VM.

export type FakeCall = {
  bin: string;
  args: string[];
  /** The remote command line: ssh's last argument. */
  remote: string;
  stdin: string;
  proc: ChildProcess;
};

export type Answer = { code?: number; stdout?: string; stderr?: string; hold?: boolean };

export function fakeSpawn(respond: (call: FakeCall) => Answer = () => ({})): {
  spawn: SpawnFn;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const spawn: SpawnFn = (bin, args) => {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const call: FakeCall = {
      bin,
      args,
      remote: args[args.length - 1] ?? '',
      stdin: '',
      proc: emitter as unknown as ChildProcess
    };
    const stdin = new Writable({
      write(chunk: Buffer, _enc, cb) {
        call.stdin += chunk.toString('utf-8');
        cb();
      }
    });
    Object.assign(emitter, { stdout, stderr, stdin, pid: 4242, kill: () => true });
    calls.push(call);
    setImmediate(() => {
      const answer = respond(call);
      if (answer.stdout) stdout.write(answer.stdout);
      if (answer.stderr) stderr.write(answer.stderr);
      if (answer.hold) return;
      stdout.end();
      stderr.end();
      setImmediate(() => emitter.emit('close', answer.code ?? 0));
    });
    return call.proc;
  };
  return { spawn, calls };
}
