/** Report only an acknowledged glasses page, never the phone/desktop preview. */
export class G2PresenceReporter {
  private key?: string;
  private sequence = 0;
  private timer?: ReturnType<typeof setInterval>;
  private enabled = true;
  constructor(private send: (data: object) => Promise<unknown>, private clientId: string) {}
  set(key?: string) {
    if (!this.enabled || key === this.key) return;
    this.key = key; clearInterval(this.timer); this.timer = undefined;
    this.report();
    if (key) this.timer = setInterval(() => this.report(), 5000);
  }
  private report() {
    void this.send({ clientId: this.clientId, sequence: ++this.sequence, sessionKey: this.key || null }).catch(() => {});
  }
  suspend() { this.set(undefined); this.enabled = false; }
  resume() { this.enabled = true; }
}
