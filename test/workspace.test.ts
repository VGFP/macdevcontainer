import { describe, expect, it } from 'vitest';
import { findDevContainerFiles, isProtectedWorkspacePath } from '../src/workspace';

describe('workspace helpers', () => {
  it('detects protected macOS folders', () => {
    expect(isProtectedWorkspacePath('/Users/test/Desktop/project', '/Users/test')).toBe(true);
    expect(isProtectedWorkspacePath('/Users/test/Documents', '/Users/test')).toBe(true);
    expect(isProtectedWorkspacePath('/Users/test/Downloads/a/b', '/Users/test')).toBe(true);
    expect(isProtectedWorkspacePath('/Users/test/Projects/app', '/Users/test')).toBe(false);
    expect(isProtectedWorkspacePath('/Users/test/DesktopOther/app', '/Users/test')).toBe(false);
  });

  it('returns no files for a workspace without a devcontainer config', async () => {
    const files = await findDevContainerFiles('/definitely/not/a/workspace');
    expect(files).toEqual([]);
  });
});
