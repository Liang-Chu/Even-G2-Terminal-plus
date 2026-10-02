// The SDK has already recognized the gesture. Do not add another tap window.
export class TapGestures {
  private guardUntil = 0;
  constructor(private actions: { single(): void; double(): void }) {}
  input(type: 0 | 3) {
    if (Date.now() < this.guardUntil) return;
    this.actions[type === 0 ? "single" : "double"]();
    // Some hosts duplicate a gesture in text and system envelopes. Apply after
    // the callback so page changes cannot clear this cross-page guard.
    this.guardUntil = Date.now() + 100;
  }
  reset() { this.guardUntil = 0; }
}
