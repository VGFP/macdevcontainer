import { describe, expect, it } from 'vitest';
import {
  buildRemoteCommand,
  quoteShellArg,
  withRemotePath,
} from '../src/container/executor';
import { parseSshRemoteHost, resolveSshRemoteHost } from '../src/remote/sshHost';
import { isProtectedPosixWorkspacePath } from '../src/workspace';

describe('parseSshRemoteHost', () => {
  it('returns a plain host alias', () => {
    expect(parseSshRemoteHost('ssh-remote+Mac_Mini_M4')).toBe('Mac_Mini_M4');
  });

  it('decodes a hex-encoded JSON authority', () => {
    const encoded = Buffer.from(
      JSON.stringify({ hostName: 'Mac_Mini_M4' }),
      'utf8',
    ).toString('hex');
    expect(parseSshRemoteHost(`ssh-remote+${encoded}`)).toBe('Mac_Mini_M4');
  });

  it('strips a parent authority', () => {
    expect(parseSshRemoteHost('ssh-remote+Mac_Mini_M4@dev-container+abc')).toBe(
      'Mac_Mini_M4',
    );
  });

  it('ignores other remote types', () => {
    expect(parseSshRemoteHost('wsl+Ubuntu')).toBeUndefined();
    expect(parseSshRemoteHost(undefined)).toBeUndefined();
  });

  it('falls back to the raw authority when hex is not JSON', () => {
    const encoded = Buffer.from('not json', 'utf8').toString('hex');
    expect(parseSshRemoteHost(`ssh-remote+${encoded}`)).toBe(encoded);
  });

  it('rejects aliases that ssh would parse as options', () => {
    expect(parseSshRemoteHost('ssh-remote+-oProxyCommand=evil')).toBeUndefined();
    expect(parseSshRemoteHost('ssh-remote+host with spaces')).toBeUndefined();
  });
});

describe('resolveSshRemoteHost', () => {
  it('uses the workspace URI authority for local UI extensions', () => {
    const encoded = Buffer.from(
      JSON.stringify({ hostName: 'Mac_Mini_M4' }),
      'utf8',
    ).toString('hex');
    expect(
      resolveSshRemoteHost('ssh-remote', `ssh-remote+${encoded}`),
    ).toBe('Mac_Mini_M4');
  });

  it('falls back to a full remoteName authority', () => {
    expect(resolveSshRemoteHost('ssh-remote+Mac_Mini_M4', undefined)).toBe(
      'Mac_Mini_M4',
    );
  });

  it('returns undefined for non-SSH remotes', () => {
    expect(resolveSshRemoteHost('wsl', 'wsl+Ubuntu')).toBeUndefined();
  });
});

describe('remote command building', () => {
  it('quotes arguments safely', () => {
    expect(quoteShellArg('plain')).toBe('plain');
    expect(quoteShellArg('/a/b:c')).toBe('/a/b:c');
    expect(quoteShellArg('two words')).toBe("'two words'");
    expect(quoteShellArg("it's")).toBe("'it'\\''s'");
    expect(quoteShellArg('$HOME')).toBe("'$HOME'");
  });

  it('builds a remote container command', () => {
    expect(
      buildRemoteCommand('container', [
        'create',
        '--mount',
        'type=bind,source=/a b/c,target=/workspaces/a b',
      ]),
    ).toBe(
      "container create --mount 'type=bind,source=/a b/c,target=/workspaces/a b'",
    );
  });

  it('adds the Homebrew and local bin paths', () => {
    expect(withRemotePath('container ls')).toContain(
      'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; container ls',
    );
  });
});

describe('isProtectedPosixWorkspacePath', () => {
  it('detects protected folders on a remote Mac', () => {
    expect(
      isProtectedPosixWorkspacePath('/Volumes/data/Desktop/project', '/Volumes/data'),
    ).toBe(true);
    expect(
      isProtectedPosixWorkspacePath('/Volumes/data/Projects/project', '/Volumes/data'),
    ).toBe(false);
  });
});
