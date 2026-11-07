import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { heartbeatUrl, tailnetFromStatus } from './statusPage';

describe('status page heartbeat', () => {
  it('beats to /heartbeat over https only', () => {
    assert.equal(
      heartbeatUrl('https://status.factiii.com/x?y=1'),
      'https://status.factiii.com/heartbeat'
    );
    assert.throws(() => heartbeatUrl('http://status.factiii.com'));
  });

  it('reads the way in from `tailscale status --json`', () => {
    const status = JSON.stringify({
      BackendState: 'Running',
      Self: {
        DNSName: 'mac-mini-m6.tail1234.ts.net.',
        TailscaleIPs: ['100.77.190.87', 'fd7a:115c:a1e0::1']
      }
    });
    assert.deepEqual(tailnetFromStatus(status, 'jon'), {
      name: 'mac-mini-m6.tail1234.ts.net',
      ip: '100.77.190.87',
      user: 'jon'
    });
  });

  it('sends nothing when the machine is not on a tailnet', () => {
    assert.equal(
      tailnetFromStatus(
        JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }),
        'jon'
      ),
      null
    );
    assert.equal(tailnetFromStatus('not json', 'jon'), null);
  });
});
