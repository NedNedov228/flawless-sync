import type { FileState } from "./types";

export class StateManager {
  // This cache mirrors the last known local/remote metadata per file to detect deltas between runs.
  private state: Map<string, FileState> = new Map();

  load(fileStates: FileState[]): void {
    this.state.clear();
    for (const entry of fileStates) {
      this.state.set(entry.path, { ...entry });
    }
  }

  toJSON(): FileState[] {
    return Array.from(this.state.values());
  }

  get(path: string): FileState | undefined {
    return this.state.get(path);
  }

  set(path: string, state: FileState) {
    this.state.set(path, state);
  }

  delete(path: string) {
    this.state.delete(path);
  }

  keys(): IterableIterator<string> {
    return this.state.keys();
  }
}
