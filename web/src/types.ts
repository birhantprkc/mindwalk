export type Action = "search" | "read" | "edit" | "exec" | "verify" | "other";
export type Touch = "hit" | "read" | "edit";

export interface SessionMeta {
  key: string;
  id: string;
  harness: string;
  title?: string;
  path: string;
  cwd?: string;
  model?: string;
  gitBranch?: string;
  startedAt?: string;
  endedAt?: string;
  eventCount: number;
}

export interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface CityMap {
  version: number;
  repo: {
    root: string;
    commit?: string;
    dirty: boolean;
    generatedAt: string;
  };
  files: CityFile[];
  dirs: CityDir[];
  layout: {
    algorithm: string;
    weight: string;
  };
}

export interface CityFile {
  id: number;
  path: string;
  dir: string;
  lines: number;
  bytes: number;
  lang?: string;
  rect: Rect;
  ghost: boolean;
}

export interface CityDir {
  path: string;
  depth: number;
  rect: Rect;
  fileCount: number;
  lines: number;
}

export interface Trace {
  version: number;
  session: {
    id: string;
    harness: string;
    model?: string;
    title?: string;
    cwd?: string;
    commit?: string;
    startedAt?: string;
    endedAt?: string;
    eventCount: number;
    path?: string;
  };
  events: TraceEvent[];
  marks: Mark[];
  stats: Stats;
}

export interface TraceEvent {
  seq: number;
  ts?: string;
  tool: string;
  action: Action;
  targets: Target[];
  outside?: OutsideTouch[];
  resultBytes: number;
  isError: boolean;
  summary: string;
}

export interface Target {
  path: string;
  fileId?: number;
  touch: Touch;
  lines?: [number, number][];
  weak?: boolean;
}

export interface OutsideTouch {
  scope: "home" | "tmp" | "other";
  path: string;
}

export interface Mark {
  seq: number;
  type: "compaction" | "user-message" | "subagent";
  note?: string;
}

export interface Stats {
  filesInRepo: number;
  fovea: number;
  parafovea: number;
  edited: number;
  eventsBeforeFirstEdit: number;
  regressionRate: number;
  errorRate: number;
  actions: ActionCounts;
  errors: ActionCounts;
  maxEditsPerFile: number;
  /** files edited in three or more events */
  churnFiles: number;
  userTurns: number;
  compactions: number;
  subagents: number;
  resultBytes: number;
  /** edit events after the last verify event; every edit event when the session never verified */
  editsAfterLastVerify: number;
}

export interface ActionCounts {
  search: number;
  read: number;
  edit: number;
  exec: number;
  verify: number;
  other: number;
}
