/**
 * Small, non-interactive pill rendered inside Meet while capture is active, so it is
 * always obvious that captions are being recorded. Shadow DOM keeps Meet's styles out
 * and keeps our element invisible to the caption parser.
 */
export type IndicatorState = 'capturing' | 'waiting-for-captions';

const HOST_ID = 'meetnotes-capture-indicator';

const STYLE = `
:host { all: initial; }
.pill {
  position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
  z-index: 2147483647; pointer-events: none;
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; border-radius: 999px;
  font: 500 12px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #fff; background: rgba(32, 33, 36, 0.92);
  box-shadow: 0 2px 8px rgba(0,0,0,.3);
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: #ea4335; animation: pulse 1.6s ease-in-out infinite; }
.pill[data-state="waiting-for-captions"] .dot { background: #fbbc04; animation: none; }
@keyframes pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
`;

const LABELS: Record<IndicatorState, string> = {
  capturing: 'MeetNotes is saving captions',
  'waiting-for-captions': 'MeetNotes: turn on captions (press C) to start saving',
};

export class CaptureIndicator {
  private host: HTMLElement | null = null;
  private pill: HTMLElement | null = null;
  private label: HTMLElement | null = null;

  constructor(private readonly doc: Document) {}

  show(state: IndicatorState): void {
    if (!this.host || !this.host.isConnected) this.mount();
    if (!this.pill || !this.label) return;
    this.pill.dataset['state'] = state;
    this.label.textContent = LABELS[state];
  }

  hide(): void {
    this.host?.remove();
    this.host = null;
    this.pill = null;
    this.label = null;
  }

  private mount(): void {
    this.doc.getElementById(HOST_ID)?.remove();
    const host = this.doc.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = this.doc.createElement('style');
    style.textContent = STYLE;
    const pill = this.doc.createElement('div');
    pill.className = 'pill';
    pill.setAttribute('role', 'status');
    const dot = this.doc.createElement('span');
    dot.className = 'dot';
    const label = this.doc.createElement('span');
    pill.append(dot, label);
    shadow.append(style, pill);
    (this.doc.body ?? this.doc.documentElement).append(host);
    this.host = host;
    this.pill = pill;
    this.label = label;
  }
}
