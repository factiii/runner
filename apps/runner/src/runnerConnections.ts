import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  RunnerConnections,
  RunnerEmbedderView,
  RunnerLinkView,
  RunnerLogSource,
  RunnerLogTail,
  RunnerPerson,
  RunnerRemoteSession,
  RunnerService,
  RunnerVaultIngest,
  RunnerExposedView,
  CardAISessionSummary
} from '@shared/all/domains/electron';
import type {
  ChannelTransport,
  VouchedScope
} from '@shared/all/helpers/board-agent-core/runner-access';
import type { SessionStarter } from '@shared/all/helpers/board-agent-core/session';
import { runnerLogsSchema } from '@shared/all/validators';

import type { EmbedderState } from './vault/embedder';

// The runner owner's view of who and what is on their machine (.specs/
// runner-window.md "Remote connections"): runnerConnections and runnerLogs.
// Owner only and runner-wide; the daemon checks the role before either is
// asked. Everything here reads; nothing starts or stops.
//
// A log is read by a name the runner's own services list has now, never by a
// name as sent: each read is execFile with its arguments (machine.ts run), no
// shell, so a name cannot become a command.

export const LOG_LINES_DEFAULT = 200;
export const LOG_LINES_MAX = 2000;
/** A services read is a few CLI calls (machineHealthIo.ts runningServices):
 *  one read serves both actions for this long. */
const SERVICES_TTL_MS = 10_000;
const LOG_TIMEOUT_MS = 10_000;
/** A launchd agent's log file is read from its end, at most this much. */
const LOG_FILE_MAX_BYTES = 1024 * 1024;

type Run = (
  bin: string,
  args: string[],
  opts?: { timeoutMs?: number }
) => Promise<{ code: number; output: string }>;

// ── Pure helpers (runnerConnections.test.ts) ──

/** `lines` off the wire: a whole number in 1..LOG_LINES_MAX, the default
 *  when absent or not a number. */
export function clampLogLines(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return LOG_LINES_DEFAULT;
  return Math.min(LOG_LINES_MAX, Math.max(1, Math.floor(raw)));
}

/**
 * Output as a log panel can show it. Escape sequences go - OSC (titles,
 * links), CSI (cursor moves, colours, clears) and the two-byte ones - and so
 * does every other control character but a tab and a newline. A carriage
 * return redraws its line (a progress bar), so only what was written after
 * the last one stays.
 */
export function stripTerminalControls(text: string): string {
  return (
    text
      // OSC: ESC ] … BEL or ESC \
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
      // CSI: ESC [ params intermediates final
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // Any other escape: ESC and one byte.
      .replace(/\x1b[@-_]?/g, '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.slice(line.lastIndexOf('\r') + 1))
      .join('\n')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  );
}

/** The last `count` lines of `text`, trailing blank lines dropped first (a
 *  pane's empty rows below its prompt). */
export function lastLines(text: string, count: number): string {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines.slice(-count).join('\n');
}

/** The service a log read names, from the services list as read now; null
 *  when it is not there. A name that could pass for a flag or a path never
 *  matches, whatever the list says. */
export function allowedService(
  services: RunnerService[],
  kind: RunnerService['kind'],
  name: string
): RunnerService | null {
  if (!name || name.startsWith('-') || /[/\\\0\n]/.test(name)) return null;
  return services.find((s) => s.kind === kind && s.name === name) ?? null;
}

/** A starter or a vouched scope as a person. A user id that is not a number
 *  (the owner's own context names none) is null. */
export function personOf(who: { userId: string; name: string; role: 'owner' | 'member' }): RunnerPerson {
  const id = /^\d{1,12}$/.test(who.userId) ? Number(who.userId) : null;
  return { userId: id, name: who.name || (who.role === 'owner' ? 'Owner' : 'Member'), role: who.role };
}

/** A session someone other than the owner started. One with no starter
 *  predates the record and counts as the owner's (session.ts startedBy). */
export function startedByOther(
  starter: SessionStarter | undefined,
  ownerUserId: string | null
): starter is SessionStarter {
  if (!starter) return false;
  if (starter.role !== 'owner') return true;
  return Boolean(ownerUserId && starter.userId && starter.userId !== ownerUserId);
}

// ── The host ──

/** One open link, as the daemon keeps it. */
export type LinkEntry = {
  id: string;
  scope: VouchedScope;
  transport: ChannelTransport;
  connectedAt: number;
  terminals: number;
};

/** One board's engine, as far as this reads it (engine.ts). */
export type ConnectionsBoard = {
  terminalSessions(): {
    summary: Pick<CardAISessionSummary, 'postId' | 'taskTitle' | 'startedAt' | 'exposed'>;
    startedBy?: SessionStarter;
  }[];
  captureTerminalTab(
    postId: string,
    tabId: string | undefined,
    lines: number
  ): Promise<{ tabId: string; text: string } | null>;
};

export type ConnectionsDeps = {
  ownerUserId: string | null;
  links: () => LinkEntry[];
  boards: () => Iterable<[string, ConnectionsBoard]>;
  embedder: {
    state(): EmbedderState;
    process(): { running: boolean; port: number | null };
    logTail(lines: number): string[];
  };
  /** Null when the runner has no Vault (daemonVault.ts ingest). */
  vaultIngest: () => Promise<RunnerVaultIngest | null>;
  /** The machine's services (machineHealthIo.ts runningServices). */
  services: () => Promise<RunnerService[]>;
  run: Run;
  now?: () => number;
};

export type RunnerConnectionsHost = {
  /** `you`: the id of the link that asked. */
  connections(you: string): Promise<RunnerConnections>;
  logs(payload: unknown): Promise<RunnerLogTail>;
};

const TRANSPORT: Record<ChannelTransport, RunnerLinkView['transport']> = {
  webrtc: 'direct',
  socket: 'socket'
};

export function createRunnerConnections(deps: ConnectionsDeps): RunnerConnectionsHost {
  const now = deps.now ?? Date.now;
  let cached: { at: number; rows: Promise<RunnerService[]> } | null = null;

  const services = (): Promise<RunnerService[]> => {
    if (!cached || now() - cached.at > SERVICES_TTL_MS) {
      const rows = deps.services().catch(() => []);
      cached = { at: now(), rows };
    }
    return cached.rows;
  };

  const embedderView = async (): Promise<RunnerEmbedderView | null> => {
    let ingest: RunnerVaultIngest | null;
    try {
      ingest = await deps.vaultIngest();
      if (!ingest) return null;
    } catch {
      // The Vault is there but its database did not answer: the embedder
      // still has a state, and the counts read as none.
      ingest = null;
    }
    const proc = deps.embedder.process();
    return {
      state: deps.embedder.state(),
      running: proc.running,
      port: proc.port,
      pending: ingest?.pending ?? 0,
      embedded: ingest?.embedded ?? 0,
      failed: ingest?.failed ?? 0,
      current: ingest?.current ?? null
    };
  };

  const connections = async (you: string): Promise<RunnerConnections> => {
    const links: RunnerLinkView[] = deps.links().map((link) => ({
      ...personOf(link.scope),
      id: link.id,
      transport: TRANSPORT[link.transport],
      boards: link.scope.role === 'member' ? [...link.scope.spaceSlugs] : null,
      connectedAt: link.connectedAt,
      you: link.id === you,
      terminals: link.terminals
    }));
    const remoteSessions: RunnerRemoteSession[] = [];
    const exposed: RunnerExposedView[] = [];
    for (const [spaceSlug, board] of deps.boards()) {
      for (const { summary, startedBy } of board.terminalSessions()) {
        const title = summary.taskTitle || 'Terminal';
        const ports = summary.exposed ?? [];
        for (const port of ports) {
          exposed.push({ ...port, postId: summary.postId, spaceSlug, title });
        }
        if (startedByOther(startedBy, deps.ownerUserId)) {
          remoteSessions.push({
            postId: summary.postId,
            spaceSlug,
            title,
            startedBy: personOf(startedBy),
            startedAt: summary.startedAt,
            exposed: ports
          });
        }
      }
    }
    const [embedder, rows] = await Promise.all([embedderView(), services()]);
    return { links, remoteSessions, embedder, services: rows, exposed, at: now() };
  };

  const tail = (label: string, raw: string, lines: number, empty: string): RunnerLogTail => {
    const text = lastLines(stripTerminalControls(raw), lines);
    return { text, label, ...(text ? {} : { note: empty }), at: now() };
  };

  const serviceLog = async (
    source: Extract<RunnerLogSource, { kind: 'service' }>,
    lines: number
  ): Promise<RunnerLogTail> => {
    const row = allowedService(await services(), source.service, source.name);
    if (!row) throw new Error(`${source.name} is not among this runner's services now.`);
    const name = row.name;
    if (row.kind === 'pm2') {
      const res = await deps.run(
        'pm2',
        ['logs', name, '--lines', String(lines), '--nostream', '--raw'],
        { timeoutMs: LOG_TIMEOUT_MS }
      );
      return tail(`pm2 logs ${name}`, res.output, lines, 'pm2 has no log lines for it.');
    }
    if (row.kind === 'docker') {
      const res = await deps.run('docker', ['logs', '--tail', String(lines), name], {
        timeoutMs: LOG_TIMEOUT_MS
      });
      return tail(`docker logs ${name}`, res.output, lines, 'The container has printed nothing.');
    }
    if (row.kind === 'launchd') return launchdLog(name, lines);
    const port = row.ports[0];
    return {
      text: '',
      label: port ? `${name} on port ${port}` : name,
      note: 'A process listening on a port keeps no log the runner can read. If a terminal started it, its tab shows the output.',
      at: now()
    };
  };

  /** The agent's StandardOutPath and StandardErrorPath, read from their
   *  ends. Neither set: launchd keeps nothing for it. */
  const launchdLog = async (label: string, lines: number): Promise<RunnerLogTail> => {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    const key = async (name: string): Promise<string | null> => {
      const res = await deps.run('plutil', ['-extract', name, 'raw', '-o', '-', plist], {
        timeoutMs: LOG_TIMEOUT_MS
      });
      const value = res.output.trim();
      return res.code === 0 && path.isAbsolute(value) ? value : null;
    };
    const files = [...new Set([await key('StandardOutPath'), await key('StandardErrorPath')])].filter(
      (f): f is string => f !== null
    );
    if (files.length === 0) {
      return { text: '', label: `launchd ${label}`, note: 'launchd keeps no log for this agent.', at: now() };
    }
    const parts = files.map((file) => {
      const body = readFileTail(file, LOG_FILE_MAX_BYTES);
      return files.length > 1 ? `--- ${file}\n${lastLines(body, lines)}` : body;
    });
    return tail(`launchd ${label}`, parts.join('\n'), lines, 'Its log files are empty.');
  };

  const logs = async (payload: unknown): Promise<RunnerLogTail> => {
    const parsed = runnerLogsSchema.safeParse(payload ?? {});
    if (!parsed.success) throw new Error('runnerLogs needs a source: a service, the embedder or a terminal.');
    const lines = clampLogLines(parsed.data.lines);
    const source = parsed.data.source;
    if (source.kind === 'service') return serviceLog(source, lines);
    if (source.kind === 'embedder') {
      return tail(
        'Embedder',
        deps.embedder.logTail(lines).join('\n'),
        lines,
        'The embedder has printed nothing since the runner started. It starts on the first Vault search or upload.'
      );
    }
    const board = [...deps.boards()].find(([slug]) => slug === source.spaceSlug)?.[1];
    const captured = board
      ? await board.captureTerminalTab(source.postId, source.tabId, lines)
      : null;
    if (!captured) {
      return { text: '', label: 'Terminal', note: 'That terminal or tab is gone.', at: now() };
    }
    const title =
      board
        ?.terminalSessions()
        .find((s) => s.summary.postId === source.postId)?.summary.taskTitle || 'Terminal';
    return tail(`${title} · tab ${captured.tabId}`, captured.text, lines, 'The tab is empty.');
  };

  return { connections, logs };
}

/** The last `maxBytes` of a file, from its first whole line; '' when it
 *  cannot be read. */
export function readFileTail(file: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf-8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
