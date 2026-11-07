import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDevContainer } from '../src/devcontainer/parse';

const file = '/repo/.devcontainer/devcontainer.json';
const workspace = '/Users/test/project';

describe('parseDevContainer', () => {
  it('applies defaults for a minimal image-based configuration', () => {
    const { config, warnings } = parseDevContainer(
      '{"image":"node:22"}',
      file,
      workspace,
    );

    expect(warnings).toEqual([]);
    expect(config.image).toBe('node:22');
    expect(config.remoteUser).toBe('root');
    expect(config.workspaceFolder).toBe('/workspaces/project');
    expect(config.forwardPorts).toEqual([]);
    expect(config.hostRequirements).toEqual({});
  });

  it('accepts comments and trailing commas', () => {
    const { config } = parseDevContainer(
      `{
        // JSONC is allowed
        "image": "mcr.microsoft.com/devcontainers/typescript-node:4-24-bookworm",
        "forwardPorts": [5173, "3000:3000",],
      }`,
      file,
      workspace,
    );

    expect(config.forwardPorts).toEqual([5173, '3000:3000']);
  });

  it('warns about known unsupported keys', () => {
    const { warnings } = parseDevContainer(
      `{
        "image": "node:22",
        "build": { "dockerfile": "Dockerfile" },
        "mounts": [],
        "features": {},
        "containerEnv": {},
        "runArgs": []
      }`,
      file,
      workspace,
    );

    expect(warnings).toHaveLength(5);
    expect(warnings.join('\n')).toContain('"build"');
    expect(warnings.join('\n')).toContain('"features"');
  });

  it('rejects a build-only configuration', () => {
    expect(() =>
      parseDevContainer('{"build":{"dockerfile":"Dockerfile"}}', file, workspace),
    ).toThrow(/Dockerfile-based builds/);
  });

  it('rejects missing image', () => {
    expect(() => parseDevContainer('{}', file, workspace)).toThrow(/"image" is required/);
  });

  it('validates host requirements', () => {
    const { config } = parseDevContainer(
      '{"image":"node:22","hostRequirements":{"cpus":2,"memory":"4GB"}}',
      file,
      workspace,
    );
    expect(config.hostRequirements).toEqual({ cpus: 2, memory: '4GB' });

    expect(() =>
      parseDevContainer('{"image":"node:22","hostRequirements":{"cpus":0}}', file, workspace),
    ).toThrow(/positive number/);
  });

  it('normalizes all lifecycle command shapes', () => {
    const { config } = parseDevContainer(
      `{
        "image": "node:22",
        "postCreateCommand": "npm install",
        "postStartCommand": {
          "start": "npm run dev",
          "wait": ["sleep 1", "echo ready"]
        }
      }`,
      file,
      workspace,
    );

    expect(config.postCreateCommand).toBe('npm install');
    expect(config.postStartCommand).toEqual({
      start: 'npm run dev',
      wait: ['sleep 1', 'echo ready'],
    });
  });

  it('validates forwardPorts entries', () => {
    expect(() =>
      parseDevContainer('{"image":"node:22","forwardPorts":["not-a-port"]}', file, workspace),
    ).toThrow(/port number/);

    expect(() =>
      parseDevContainer('{"image":"node:22","forwardPorts":[70000]}', file, workspace),
    ).toThrow(/between 1 and 65535/);
  });

  it('rejects unsafe workspace folders', () => {
    expect(() =>
      parseDevContainer('{"image":"node:22","workspaceFolder":"relative"}', file, workspace),
    ).toThrow(/absolute container path/);

    expect(() =>
      parseDevContainer('{"image":"node:22","workspaceFolder":"/"}', file, workspace),
    ).toThrow(/container root/);

    expect(() =>
      parseDevContainer('{"image":"node:22","workspaceFolder":"/a/../b"}', file, workspace),
    ).toThrow(/".." segments/);
  });

  it('reports malformed JSON with a location', () => {
    expect(() => parseDevContainer('{"image": }', file, workspace)).toThrow(/Cannot parse/);
  });

  it('parses the bundled end-to-end example', async () => {
    const exampleRoot = join(process.cwd(), 'examples', 'node');
    const exampleFile = join(exampleRoot, '.devcontainer', 'devcontainer.json');
    const parsed = parseDevContainer(
      await readFile(exampleFile, 'utf8'),
      exampleFile,
      exampleRoot,
    );

    expect(parsed.warnings).toEqual([]);
    expect(parsed.config.image).toContain('typescript-node');
    expect(parsed.config.workspaceFolder).toBe('/workspaces/example');
    expect(parsed.config.forwardPorts).toEqual([3000]);
    expect(parsed.config.hostRequirements).toEqual({ cpus: 2, memory: '2GB' });
  });
});
