import { describe, expect, it } from 'vitest';
import {
  buildManagedSshBlock,
  forwardPortsToLocalForwards,
  parseForwardPort,
  removeManagedSshBlock,
  upsertManagedSshBlock,
  type SshHostEntry,
} from '../src/ssh/config';

const entry: SshHostEntry = {
  host: 'macdc-project-abc123',
  hostName: '192.168.64.5',
  user: 'root',
  identityFile: '/Users/test/.macdevcontainer/keys/abc_ed25519',
  forwardPorts: [5173, '3000:3000'],
};

describe('ssh config', () => {
  it('writes a managed host block with port forwards', () => {
    const block = buildManagedSshBlock(entry);

    expect(block).toContain('Host macdc-project-abc123');
    expect(block).toContain('HostName 192.168.64.5');
    expect(block).toContain('User root');
    expect(block).toContain('IdentityFile /Users/test/.macdevcontainer/keys/abc_ed25519');
    expect(block).toContain('StrictHostKeyChecking no');
    expect(block).toContain('LocalForward 5173 127.0.0.1:5173');
    expect(block).toContain('LocalForward 3000 127.0.0.1:3000');
  });

  it('includes the tunnel port when one is given', () => {
    const block = buildManagedSshBlock({ ...entry, port: 43210 });
    expect(block).toContain('HostName 192.168.64.5');
    expect(block).toContain('Port 43210');
  });

  it('quotes identity paths containing spaces', () => {
    const block = buildManagedSshBlock({
      ...entry,
      identityFile: '/Users/test/My Keys/key',
    });
    expect(block).toContain('IdentityFile "/Users/test/My Keys/key"');
  });

  it('adds a block and preserves existing configuration', () => {
    const existing = 'Host github.com\n    User git\n';
    const updated = upsertManagedSshBlock(existing, entry);

    expect(updated).toContain('Host github.com');
    expect(updated).toContain('Host macdc-project-abc123');
    expect(updated.endsWith('\n')).toBe(true);
  });

  it('replaces only the matching managed block', () => {
    const other: SshHostEntry = { ...entry, host: 'macdc-other-def456', hostName: '192.168.64.9' };
    const first = upsertManagedSshBlock('Host github.com\n    User git\n', other);
    const second = upsertManagedSshBlock(first, entry);
    const third = upsertManagedSshBlock(second, { ...entry, hostName: '192.168.64.6' });

    expect(third).toContain('Host github.com');
    expect(third).toContain('Host macdc-other-def456');
    expect(third).toContain('HostName 192.168.64.6');
    expect(third).not.toContain('HostName 192.168.64.5');
    expect(third.match(/Host macdc-project-abc123/g)).toHaveLength(1);
  });

  it('removes a managed block without touching the rest', () => {
    const first = upsertManagedSshBlock('Host github.com\n    User git\n', entry);
    const removed = removeManagedSshBlock(first, entry.host);

    expect(removed).toContain('Host github.com');
    expect(removed).not.toContain('macdc-project-abc123');
  });

  it('parses number and host:container port specifications', () => {
    expect(parseForwardPort(5173)).toEqual({ localPort: 5173, remotePort: 5173 });
    expect(parseForwardPort('3000:3000')).toEqual({ localPort: 3000, remotePort: 3000 });
    expect(parseForwardPort('8080:80')).toEqual({ localPort: 8080, remotePort: 80 });
    expect(parseForwardPort('0')).toBeUndefined();
    expect(parseForwardPort('abc')).toBeUndefined();
  });

  it('deduplicates forwards by local port', () => {
    expect(forwardPortsToLocalForwards([5173, '5173:5173', '8080:80'])).toEqual([
      { localPort: 5173, remotePort: 5173 },
      { localPort: 8080, remotePort: 80 },
    ]);
  });
});
