import { describe, expect, it } from 'vitest';
import {
  buildInstallKeyScript,
  SSHD_INSTALL_SCRIPT,
  unlockAccount,
  type CommandTarget,
} from '../src/container/ssh';

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

describe('authorized key script', () => {
  it('embeds values as quoted shell literals instead of positional arguments', () => {
    const script = buildInstallKeyScript(
      'alice',
      'ssh-ed25519 AAAA test@example',
      'abc123',
    );

    expect(script).toContain("u='alice'");
    expect(script).toContain("key='ssh-ed25519 AAAA test@example'");
    expect(script).toContain("pattern='macdevcontainer:abc123'");
    expect(script).not.toContain('"$1"');
  });

  it('escapes single quotes safely', () => {
    const script = buildInstallKeyScript("o'brien", 'key', 'id');
    expect(script).toContain(`u='o'\\''brien'`);
  });
});

describe('unlockAccount', () => {
  it('replaces the lock marker with an unusable password hash', async () => {
    let script = '';
    const target: CommandTarget = {
      label: 'test',
      shell: async (value) => {
        script = value;
        return { stdout: '', stderr: '', code: 0, signal: null };
      },
    };

    await unlockAccount(target, "o'brien");

    expect(script).toContain(`u='o'\\''brien'`);
    expect(script).toContain('/etc/shadow');
    expect(script).toContain('$2 = "x"');
  });
});
