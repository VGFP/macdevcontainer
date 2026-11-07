export type LifecycleCommand =
  | string
  | string[]
  | Record<string, string | string[]>;

export interface HostRequirements {
  cpus?: number;
  memory?: string;
}

/** The subset of devcontainer.json supported by the MVP. */
export interface DevContainerConfig {
  name?: string;
  image: string;
  remoteUser: string;
  workspaceFolder: string;
  forwardPorts: Array<number | string>;
  postCreateCommand?: LifecycleCommand;
  postStartCommand?: LifecycleCommand;
  hostRequirements: HostRequirements;
}

export interface ParsedDevContainer {
  config: DevContainerConfig;
  warnings: string[];
}
