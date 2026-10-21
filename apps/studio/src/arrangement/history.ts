import type { CueSnapshot } from './types';

const HISTORY_LIMIT = 100;

/**
 * Undo/redo stacks for cue edits. Snapshots are supplied by the owner so this
 * stays independent of the DOM and the rest of the arrangement state.
 */
export class CueHistory {
  private readonly undoStack: CueSnapshot[] = [];
  private readonly redoStack: CueSnapshot[] = [];

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  /** Record an undo step and drop any redo branch. */
  push(snapshot: CueSnapshot): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Pop the previous state, saving `current` for redo. */
  undo(current: CueSnapshot): CueSnapshot | null {
    const previous = this.undoStack.pop();
    if (previous === undefined) return null;
    this.redoStack.push(current);
    return previous;
  }

  /** Pop the next state, saving `current` for undo. */
  redo(current: CueSnapshot): CueSnapshot | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(current);
    return next;
  }
}
