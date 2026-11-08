import { describe, expect, it } from 'vitest';
import { SSHD_INSTALL_SCRIPT } from '../src/container/ssh';

describe('sshd install script', () => {
  it('supports the common package managers', () => {
    for (const manager of ['apt-get', 'apk', 'dnf', 'yum', 'pacman']) {
      expect(SSHD_INSTALL_SCRIPT).toContain(manager);
    }
  });

  it('fails clearly when no package manager is available', () => {
    expect(SSHD_INSTALL_SCRIPT).toContain('No supported package manager found');
    expect(SSHD_INSTALL_SCRIPT).toContain('exit 42');
  });
});
