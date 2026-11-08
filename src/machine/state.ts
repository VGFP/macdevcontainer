/**
 * Lifecycle bookkeeping inside a container machine. State lives in the
 * machine's Linux home directory (not the mounted macOS home), so it is scoped
 * to the machine and disappears with it.
 */
export const MACHINE_STATE_DIRECTORY = '$HOME/.macdevcontainer/state';

export function postCreateMarker(projectId: string): string {
  return `${projectId}.postCreate.done`;
}

/** Shell script that succeeds when postCreateCommand already ran. */
export function buildPostCreateCheckScript(projectId: string): string {
  return `test -f "${MACHINE_STATE_DIRECTORY}/${postCreateMarker(projectId)}"`;
}

/** Shell script that records a successful postCreateCommand. */
export function buildPostCreateMarkScript(projectId: string): string {
  return [
    `mkdir -p "${MACHINE_STATE_DIRECTORY}"`,
    `: > "${MACHINE_STATE_DIRECTORY}/${postCreateMarker(projectId)}"`,
  ].join('\n');
}
