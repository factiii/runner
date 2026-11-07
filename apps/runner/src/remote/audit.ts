import type { BoardAgentActionMap } from '@shared/all/domains/electron';

import { PROCEDURES, type Api } from './api';

type AuditQuery = BoardAgentActionMap['auditRead']['payload'];
type AuditResult = BoardAgentActionMap['auditRead']['result'];

function cell(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

/** Render the audit page as a fixed-width table plus the chain verdict. */
export function formatAudit(result: AuditResult): string {
  const lines: string[] = [];
  const cols: [string, number][] = [
    ['TIME', 20],
    ['ACTOR', 16],
    ['VIA', 14],
    ['ACTION', 15],
    ['JOB', 16],
    ['KEYS', 24],
    ['EXIT', 5],
    ['DURATION', 9]
  ];
  lines.push(cols.map(([h, w]) => cell(h, w)).join(' ').trimEnd());
  for (const e of result.entries) {
    const row = [
      e.ts.replace('T', ' ').slice(0, 19),
      e.actor.name || e.actor.userId,
      e.via,
      e.action,
      e.job ?? '',
      e.keys.join(','),
      e.exitCode === null ? '' : String(e.exitCode),
      e.durationMs === null ? '' : `${(e.durationMs / 1000).toFixed(1)}s`
    ];
    lines.push(row.map((v, i) => cell(v, cols[i][1])).join(' ').trimEnd());
  }
  if (!result.entries.length) lines.push('(no entries)');
  lines.push('');
  lines.push(
    result.chainIntact
      ? 'Chain: intact'
      : `Chain: BROKEN at the line dated ${result.firstBrokenTs ?? 'unknown'}`
  );
  return `${lines.join('\n')}\n`;
}

export async function printAudit(
  api: Api,
  args: { spaceSlug: string; runnerId: number; query: AuditQuery },
  io: { out: (text: string) => void }
): Promise<number> {
  const result = await api.query<AuditResult>(PROCEDURES.audit, args);
  io.out(formatAudit(result));
  // A broken chain is a finding a script must be able to catch.
  return result.chainIntact ? 0 : 2;
}
