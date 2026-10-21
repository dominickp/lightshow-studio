import { describe, expect, it } from 'vitest';
import { CueHistory } from './history';
import type { CueSnapshot } from './types';

const snapshot = (id: string): CueSnapshot => ({
  cues: [{ id, fixtureId: 'a', startSec: 0, endSec: 1, colorIndex: 0, action: 'hold' }],
  selectedCueIds: [id],
});

describe('CueHistory', () => {
  it('returns null when there is nothing to undo or redo', () => {
    const history = new CueHistory();
    expect(history.undo(snapshot('current'))).toBeNull();
    expect(history.redo(snapshot('current'))).toBeNull();
  });

  it('swaps the current state through undo and redo', () => {
    const history = new CueHistory();
    const first = snapshot('first');
    const second = snapshot('second');
    history.push(first);

    const undone = history.undo(second);
    expect(undone?.cues[0]?.id).toBe('first');

    const redone = history.redo(first);
    expect(redone?.cues[0]?.id).toBe('second');
  });

  it('drops the redo branch when a new step is recorded', () => {
    const history = new CueHistory();
    history.push(snapshot('first'));
    history.undo(snapshot('second'));
    history.push(snapshot('branch'));
    expect(history.redo(snapshot('current'))).toBeNull();
  });

  it('caps the undo stack so long sessions stay bounded', () => {
    const history = new CueHistory();
    for (let index = 0; index < 101; index += 1) history.push(snapshot(`state-${index}`));
    let current = snapshot('current');
    let steps = 0;
    for (;;) {
      const previous = history.undo(current);
      if (previous === null) break;
      current = previous;
      steps += 1;
    }
    expect(steps).toBe(100);
  });
});
