import {
  initialState,
  type NormalizedPiEvent,
  type RuntimeState,
} from "./types.js";
import { reducePiEvent } from "./reducer.js";

export class CockpitStore {
  state: RuntimeState;
  private listeners = new Set<
    (state: RuntimeState, event: NormalizedPiEvent) => void
  >();
  constructor(cwd: string) {
    this.state = initialState(cwd);
  }
  dispatch(event: NormalizedPiEvent) {
    this.state = reducePiEvent(this.state, event);
    for (const listener of this.listeners) listener(this.state, event);
  }
  publish(state: RuntimeState, event: NormalizedPiEvent) {
    this.state = { ...state, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.state, event);
  }
  subscribe(listener: (state: RuntimeState, event: NormalizedPiEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
