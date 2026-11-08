import { describe, expect, it } from 'vitest';
import { containerNameForWorkspace, projectId, sanitizeName } from '../src/container/naming';

describe('naming', () => {
  it('is deterministic for a workspace path', () => {
    expect(projectId('/Users/test/project')).toBe(projectId('/Users/test/project'));
    expect(containerNameForWorkspace('/Users/test/project')).toBe(
      containerNameForWorkspace('/Users/test/project'),
    );
  });

  it('differs for different workspace paths with the same basename', () => {
    expect(containerNameForWorkspace('/Users/test/one/project')).not.toBe(
      containerNameForWorkspace('/Users/test/two/project'),
    );
  });

  it('produces a safe container name', () => {
    const name = containerNameForWorkspace('/Users/test/My Project!');
    expect(name).toMatch(/^macdc-[a-z0-9._-]+$/);
    expect(name.length).toBeLessThanOrEqual(50);
  });

  it('sanitizes unusual characters and trims separators', () => {
    expect(sanitizeName('  Foo / Bar!! ')).toBe('foo-bar');
    expect(sanitizeName('---')).toBe('');
  });
});
