/**
 * Builds a DOM that mimics Google Meet's layout and live-captions markup:
 *
 * <div class="stage">
 *   <div data-participant-id="…"><video/></div>   ← participant tile
 *   <div class="captions-panel">                  ← hidden by MeetNotes as a whole
 *     <div class="lang-bar">
 *       <button aria-haspopup="listbox">🌐 English ▾</button>  <button>format_size</button>
 *     </div>
 *     <div role="region" aria-label="Captions">
 *   <div class="nMcdL">                      ← one block per speaker turn
 *     <div class="KcIKyf"><img/><span class="NWpY1d">Alice</span></div>
 *     <div class="ygicle">caption text…</div>
 *   </div>
 *   <button>jump to bottom</button>          ← non-caption noise
 * </div>
 */
export interface FakeBlock {
  readonly element: HTMLElement;
  readonly textEl: HTMLElement;
  readonly speakerEl: HTMLElement;
}

export interface FakeMeetOptions {
  /** Use unknown class names to exercise the structural fallback. */
  readonly obfuscated?: boolean;
}

export const FAKE_LANGUAGES = ['English', 'Hindi', 'Español (México)', 'Français'];

export class FakeMeet {
  region: HTMLElement | null = null;
  panel: HTMLElement | null = null;
  host: HTMLElement | null = null;
  readonly stage: HTMLElement;
  readonly tile: HTMLElement;
  readonly blocks: FakeBlock[] = [];
  language = 'English';

  constructor(
    private readonly doc: Document,
    private readonly options: FakeMeetOptions = {},
  ) {
    this.stage = doc.createElement('div');
    this.stage.className = 'stage';
    this.tile = doc.createElement('div');
    this.tile.setAttribute('data-participant-id', 'spaces/x/devices/1');
    this.tile.append(doc.createElement('video'));
    this.stage.append(this.tile);
    doc.body.append(this.stage);
  }

  get languagePicker(): HTMLButtonElement | null {
    return this.panel?.querySelector<HTMLButtonElement>('button.fake-lang-picker') ?? null;
  }

  /** Own reference (not a global id lookup) so stale instances can't touch it. */
  languageMenu: HTMLElement | null = null;

  enableCaptions(): HTMLElement {
    const o = this.options.obfuscated;
    // Real structure (2026-11-11): overlay host > D1tHje > a4cQT(panel) > [NmXUuc(lang bar), DtJ7e > iOzk7 > region]
    const host = this.doc.createElement('div');
    host.className = o ? 'q1' : 'fJsklc nulMpf';
    host.setAttribute('style', 'bottom: 80px');
    const inner = this.doc.createElement('div');
    const panel = this.doc.createElement('div');
    panel.className = o ? 'q2' : 'a4cQT P9KVBf';
    const bar = this.doc.createElement('div');
    bar.className = o ? 'q3' : 'NmXUuc';
    // Like the real one: a plain button, no aria-haspopup / combobox semantics.
    const picker = this.doc.createElement('button');
    picker.className = 'fake-lang-picker';
    picker.innerHTML = `<i class="google-symbols">language</i><span class="lang">${this.language}</span><i class="google-symbols">arrow_drop_down</i>`;
    picker.addEventListener('click', () => (this.menuOpen ? this.closeLanguageMenu() : this.openLanguageMenu()));
    const fontButton = this.doc.createElement('button');
    fontButton.innerHTML = '<i class="google-symbols">format_size</i>';
    const settingsButton = this.doc.createElement('button');
    settingsButton.innerHTML = '<i class="google-symbols">settings</i>';
    bar.append(picker, fontButton, settingsButton);
    this.doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeLanguageMenu();
    });
    // The language list is pre-rendered (hidden) and only shown when opened.
    const menu = this.doc.createElement('ul');
    menu.id = 'fake-lang-menu';
    menu.setAttribute('role', 'listbox');
    menu.style.display = 'none';
    for (const language of FAKE_LANGUAGES) {
      const option = this.doc.createElement('li');
      option.setAttribute('role', 'option');
      option.innerHTML = `<i class="google-symbols">check</i><span>${language}</span>`;
      option.addEventListener('click', () => {
        this.language = language;
        const label = this.languagePicker?.querySelector('.lang');
        if (label) label.textContent = language;
        this.closeLanguageMenu();
      });
      menu.append(option);
    }
    this.doc.body.append(menu);
    this.languageMenu = menu;

    const captionsWrap = this.doc.createElement('div');
    const scroller = this.doc.createElement('div');
    scroller.setAttribute('jsname', 'dsyhDe');
    const region = this.doc.createElement('div');
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'Captions');
    region.setAttribute('tabindex', '0');
    // The real region contains a "Jump to bottom" control next to the captions,
    // whose label can mention captions; it must never be mistaken for the CC button.
    const noise = this.doc.createElement('div');
    noise.innerHTML =
      '<button aria-label="Jump to bottom of captions"><i class="google-symbols">arrow_downward</i><span>Jump to bottom</span></button>';
    region.append(noise);
    scroller.append(region);
    captionsWrap.append(scroller);
    panel.append(bar, captionsWrap);
    inner.append(panel);
    host.append(inner);
    this.stage.append(host);
    this.host = host;
    this.panel = panel;
    this.region = region;
    return region;
  }

  disableCaptions(): void {
    this.host?.remove();
    this.host = null;
    this.panel = null;
    this.region = null;
    this.blocks.length = 0;
    this.languageMenu?.remove();
    this.languageMenu = null;
  }

  get menuOpen(): boolean {
    return this.languageMenu?.style.display === 'block';
  }

  private openLanguageMenu(): void {
    setTimeout(() => {
      const menu = this.languageMenu;
      if (menu) menu.style.display = 'block';
    }, 10); // async, like Meet
  }

  private closeLanguageMenu(): void {
    const menu = this.languageMenu;
    if (menu) menu.style.display = 'none';
  }

  addBlock(speaker: string, text: string): FakeBlock {
    if (!this.region) throw new Error('captions disabled');
    const o = this.options.obfuscated;
    const element = this.doc.createElement('div');
    element.className = o ? 'zz1' : 'nMcdL';
    const speakerWrap = this.doc.createElement('div');
    speakerWrap.className = o ? 'zz2' : 'KcIKyf';
    const avatar = this.doc.createElement('img');
    const speakerEl = this.doc.createElement('span');
    speakerEl.className = o ? 'zz3' : 'NWpY1d';
    speakerEl.textContent = speaker;
    speakerWrap.append(avatar, speakerEl);
    const textEl = this.doc.createElement('div');
    textEl.className = o ? 'zz4' : 'ygicle';
    textEl.append(this.doc.createTextNode(text));
    element.append(speakerWrap, textEl);
    const noise = this.region.lastElementChild;
    this.region.insertBefore(element, noise);
    const block = { element, textEl, speakerEl };
    this.blocks.push(block);
    return block;
  }

  /** Clicks on "Translate speech" in the captions popup (must stay 0). */
  translateClicks = 0;
  captionsPopup: HTMLElement | null = null;

  /**
   * Adds Meet's toolbar captions button. Older Meet: clicking toggles captions.
   * Newer Meet (`popup: true`): clicking opens a popup with "Live captions" and
   * "Translate speech" toggles that stays open until Escape.
   */
  addCaptionsButton({ popup = false }: { popup?: boolean } = {}): HTMLButtonElement {
    const button = this.doc.createElement('button');
    button.setAttribute('aria-label', 'Turn on captions');
    button.setAttribute('aria-pressed', 'false');
    button.innerHTML = '<i class="google-symbols">closed_caption</i>';
    const toggleCaptions = (): void => {
      // Real Meet renders the region asynchronously.
      setTimeout(() => (this.region ? this.disableCaptions() : this.enableCaptions()), 20);
    };
    if (!popup) {
      button.addEventListener('click', toggleCaptions);
    } else {
      button.addEventListener('click', () => {
        if (this.captionsPopup) return this.closeCaptionsPopup();
        const menu = this.doc.createElement('div');
        const live = this.doc.createElement('button');
        live.setAttribute('aria-pressed', String(this.region !== null));
        live.textContent = 'Live captions';
        live.addEventListener('click', () => {
          live.setAttribute('aria-pressed', String(this.region === null));
          toggleCaptions();
        });
        const translate = this.doc.createElement('button');
        translate.setAttribute('aria-pressed', 'false');
        translate.textContent = 'Translate speech';
        translate.addEventListener('click', () => this.translateClicks++);
        menu.append(live, translate);
        this.doc.body.append(menu);
        this.captionsPopup = menu;
        button.setAttribute('aria-expanded', 'true');
      });
      this.doc.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') this.closeCaptionsPopup();
      });
    }
    this.captionsButton = button;
    this.doc.body.append(button);
    return button;
  }

  captionsButton: HTMLButtonElement | null = null;

  private closeCaptionsPopup(): void {
    this.captionsPopup?.remove();
    this.captionsPopup = null;
    this.captionsButton?.setAttribute('aria-expanded', 'false');
  }

  /** Mutates the existing text node (characterData mutation), like Meet does. */
  setText(block: FakeBlock, text: string): void {
    const node = block.textEl.firstChild;
    if (node && node.nodeType === 3) node.nodeValue = text;
    else block.textEl.textContent = text;
  }

  removeBlock(block: FakeBlock): void {
    block.element.remove();
    const i = this.blocks.indexOf(block);
    if (i >= 0) this.blocks.splice(i, 1);
  }

  /** Replaces every block element with a fresh clone (Meet re-render). */
  rerenderAll(): void {
    for (const [i, block] of this.blocks.entries()) {
      const clone = block.element.cloneNode(true) as HTMLElement;
      block.element.replaceWith(clone);
      const speakerEl = clone.querySelector<HTMLElement>(this.options.obfuscated ? '.zz3' : '.NWpY1d');
      const textEl = clone.querySelector<HTMLElement>(this.options.obfuscated ? '.zz4' : '.ygicle');
      if (!speakerEl || !textEl) throw new Error('bad clone');
      this.blocks[i] = { element: clone, speakerEl, textEl };
    }
  }
}

/** Lets pending MutationObserver callbacks and short timers run. */
export const settle = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
