import { describe, expect, it } from 'vitest';
import {
  defaultKnownHostsFile,
  isValidHostKey,
  updateKnownHostsEntry,
} from '../src/ssh/hostkeys';

const ed25519Key = `ssh-ed25519 ${'A'.repeat(68)} macdevcontainer:host`;
const rsaKey = `ssh-rsa ${'B'.repeat(372)} macdevcontainer:host`;
const otherKey = `ssh-ed25519 ${'C'.repeat(68)} macdevcontainer:host`;

describe('isValidHostKey', () => {
  it('accepts single well-formed host key lines', () => {
    expect(isValidHostKey(ed25519Key)).toBe(true);
    expect(isValidHostKey(rsaKey)).toBe(true);
    expect(isValidHostKey(`  ${ed25519Key}  `)).toBe(true);
  });

  it('rejects malformed or multi-line values', () => {
    expect(isValidHostKey('')).toBe(false);
    expect(isValidHostKey('garbage')).toBe(false);
    expect(isValidHostKey(`${ed25519Key}\n${otherKey}`)).toBe(false);
    expect(isValidHostKey('ssh-ed25519 SHORT macdevcontainer:host')).toBe(false);
  });
});

describe('updateKnownHostsEntry', () => {
  it('replaces the entry for the same alias and preserves other lines', () => {
    const existing = `other-host ${otherKey}\nmacdc-a ${ed25519Key}\n`;
    const updated = updateKnownHostsEntry(existing, 'macdc-a', rsaKey);

    expect(updated).toContain(`other-host ${otherKey}`);
    expect(updated).toContain(`macdc-a ${rsaKey}`);
    expect(updated).not.toContain(ed25519Key);
    expect(updated.trim().split('\n')).toHaveLength(2);
    expect(updated.endsWith('\n')).toBe(true);
  });

  it('appends when no entry exists yet', () => {
    const updated = updateKnownHostsEntry('', 'macdc-a', ed25519Key);
    expect(updated).toBe(`macdc-a ${ed25519Key}\n`);
  });

  it('does not match a prefix of another alias', () => {
    const existing = `macdc-abc ${otherKey}\n`;
    const updated = updateKnownHostsEntry(existing, 'macdc-ab', ed25519Key);
    expect(updated).toContain(`macdc-abc ${otherKey}`);
    expect(updated).toContain(`macdc-ab ${ed25519Key}`);
  });

  it('rejects invalid aliases and host keys', () => {
    expect(() => updateKnownHostsEntry('', 'evil alias', ed25519Key)).toThrow(
      /host alias/,
    );
    expect(() => updateKnownHostsEntry('', 'macdc-a', 'not-a-key')).toThrow(
      /host key/,
    );
    expect(() => updateKnownHostsEntry('', '-macdc-a', ed25519Key)).toThrow(
      /host alias/,
    );
  });
});

describe('defaultKnownHostsFile', () => {
  it('lives inside the macdevcontainer state directory', () => {
    expect(defaultKnownHostsFile('/Users/test')).toBe(
      '/Users/test/.macdevcontainer/known_hosts',
    );
  });
});
