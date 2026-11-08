import { describe, expect, it } from 'vitest';
import {
  buildPostCreateCheckScript,
  buildPostCreateMarkScript,
  MACHINE_STATE_DIRECTORY,
  postCreateMarker,
} from '../src/machine/state';

describe('container machine state', () => {
  it('checks for the postCreate marker', () => {
    const script = buildPostCreateCheckScript('abc123');

    expect(script).toBe(`test -f "${MACHINE_STATE_DIRECTORY}/abc123.postCreate.done"`);
    expect(postCreateMarker('abc123')).toBe('abc123.postCreate.done');
  });

  it('marks a successful postCreate run', () => {
    const script = buildPostCreateMarkScript('abc123');

    expect(script).toContain('mkdir -p');
    expect(script).toContain(`${MACHINE_STATE_DIRECTORY}/abc123.postCreate.done`);
  });
});
