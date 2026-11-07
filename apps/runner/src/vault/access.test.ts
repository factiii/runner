import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseRunnerVaultMembers,
  parseVouchedScope,
  relaySecretsRefusal,
  RELAY_VAULT_REFUSAL
} from '@shared/all/helpers/board-agent-core/runner-access';

import {
  askEngineAllowed,
  deletableRows,
  vaultActionAllowed,
  vaultReaders,
  vaultRole
} from './access';

// Who gets into the runner's Vault: the owner, or a member both halves let
// in (the server's vouch and the runner's own list), and never over the relay.

const owner = { role: 'owner' as const, userId: '1', name: 'Owner' };
const member = (vault: boolean, userId = '2') => ({
  role: 'member' as const,
  spaceSlugs: [],
  userId,
  name: 'Peer',
  vault
});

describe('vault access', () => {
  it('lets the owner in, and a member only with both halves', () => {
    const members = new Set(['2']);
    assert.equal(vaultRole(owner, new Set()), 'owner');
    assert.equal(vaultRole(member(true), members), 'member');
    // The server vouched, the owner did not let them in.
    assert.equal(vaultRole(member(true, '3'), members), null);
    // The owner let them in, the server did not vouch (share ended on Factiii).
    assert.equal(vaultRole(member(false), members), null);
  });

  it('keeps who is in to the owner', () => {
    assert.equal(vaultActionAllowed('owner', 'vaultShareSet'), true);
    assert.equal(vaultActionAllowed('member', 'vaultShareSet'), false);
    assert.equal(vaultActionAllowed('member', 'vaultFiles'), true);
    assert.equal(vaultActionAllowed('member', 'vaultDelete'), true);
    // Categorize runs on the owner's machine and sign-in.
    assert.equal(vaultActionAllowed('owner', 'vaultCategorizeStart'), true);
    assert.equal(vaultActionAllowed('member', 'vaultCategorizeStart'), false);
    assert.equal(vaultActionAllowed('member', 'vaultCategorizeStatus'), false);
    // A file's page and the kept notes are the owner's reading.
    assert.equal(vaultActionAllowed('owner', 'vaultFilePost'), true);
    assert.equal(vaultActionAllowed('member', 'vaultFilePost'), false);
    assert.equal(vaultActionAllowed('member', 'vaultNotes'), false);
    assert.equal(vaultActionAllowed('member', 'vaultNoteDelete'), false);
  });

  it('lets anyone in ask with Ollama, and only the owner with Claude or Codex', () => {
    assert.equal(askEngineAllowed('member', 'ollama'), true);
    assert.equal(askEngineAllowed('member', 'claude'), false);
    assert.equal(askEngineAllowed('member', 'codex'), false);
    assert.equal(askEngineAllowed('owner', 'claude'), true);
    assert.equal(askEngineAllowed('owner', 'codex'), true);
  });

  it('reads everyone in, deletes only your own', () => {
    assert.deepEqual(vaultReaders('1', new Set(['2', 'x'])), [1, 2]);
    const rows = [{ userId: 1 }, { userId: 2 }, { userId: 2 }];
    assert.deepEqual(deletableRows(rows, '2'), { mine: [rows[1], rows[2]], kept: 1 });
  });

  it('reads the vault vouch off the scope, never for the owner', () => {
    assert.equal(
      (parseVouchedScope({ role: 'member', spaceSlugs: [], userId: '2', vault: true }) as {
        vault?: boolean;
      }).vault,
      true
    );
    assert.equal(
      (parseVouchedScope({ role: 'member', spaceSlugs: [], userId: '2', vault: 'yes' }) as {
        vault?: boolean;
      }).vault,
      false
    );
  });

  it('reads the members a runner reports, and nothing malformed', () => {
    assert.deepEqual(parseRunnerVaultMembers({ grants: {}, vault: ['2', '2', 'x', 3, ''] }), ['2']);
    assert.deepEqual(parseRunnerVaultMembers({ grants: {} }), []);
    assert.deepEqual(parseRunnerVaultMembers(null), []);
  });

  it('refuses every vault action on the relay, none on a direct link', () => {
    assert.equal(relaySecretsRefusal('socket', 'vaultRead', {}), RELAY_VAULT_REFUSAL);
    assert.equal(relaySecretsRefusal('socket', 'vaultStatus', {}), RELAY_VAULT_REFUSAL);
    assert.equal(relaySecretsRefusal('webrtc', 'vaultWrite', {}), null);
  });
});
