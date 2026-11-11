import { createLogger, type Logger } from '../../shared/logger';
import type { CaptionLanguageInfo } from '../../shared/types';
import { ICON_LIGATURE, isRendered, visibleText } from '../captions/dom-utils';

/**
 * Reads and changes Meet's caption language by operating Meet's own language
 * picker (which lives in the captions panel MeetNotes hides). Exactly the
 * clicks a user would make; nothing else on the page is touched.
 */
export interface CaptionLanguageControl {
  /** Current language; `withOptions` also opens Meet's list to read the choices. */
  get(withOptions: boolean): Promise<CaptionLanguageInfo>;
  set(language: string): Promise<CaptionLanguageInfo>;
}

/** Preferred: proper dropdown semantics. Fallback: any labelled button in the panel. */
const PICKER_SELECTORS = [
  '[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], [aria-haspopup="true"]',
  'button, [role="button"]',
];
const OPTION_SELECTOR = '[role="option"], [role="menuitemradio"], [role="menuitem"]';

export interface MeetCaptionLanguageDeps {
  readonly document: Document;
  /** The captions panel (null when captions are off). */
  readonly getPanel: () => Element | null;
  /** The caption text region inside the panel (the picker is never inside it). */
  readonly getRegion: () => Element | null;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly logger?: Logger;
}

export class MeetCaptionLanguage implements CaptionLanguageControl {
  private readonly logger: Logger;

  constructor(private readonly deps: MeetCaptionLanguageDeps) {
    this.logger = deps.logger ?? createLogger('caption-language');
  }

  async get(withOptions: boolean): Promise<CaptionLanguageInfo> {
    const picker = this.requirePicker();
    if (!withOptions) return { current: pickerLabel(picker), options: [] };
    const options = await this.withOpenMenu(picker, (items) => items.map(optionLabel).filter(isLanguageLabel));
    return { current: pickerLabel(picker), options: unique(options) };
  }

  async set(language: string): Promise<CaptionLanguageInfo> {
    const picker = this.requirePicker();
    const chosen = await this.withOpenMenu(
      picker,
      (items) => {
        const match = items.find((item) => optionLabel(item) === language);
        match?.click();
        return match !== undefined;
      },
      { closeAfter: false },
    );
    if (!chosen) {
      this.closeMenu(picker);
      throw new Error(`Meet does not offer "${language}" as a caption language.`);
    }
    await this.sleep(400); // let Meet apply the change
    this.logger.info('language.changed', { language });
    return { current: pickerLabel(this.requirePicker()), options: [] };
  }

  private requirePicker(): HTMLElement {
    const panel = this.deps.getPanel();
    if (!panel) throw new Error('Captions are off. Turn them on to choose a language.');
    const region = this.deps.getRegion();
    for (const selector of PICKER_SELECTORS) {
      // Outside the caption text, with a text label ("English"); icon-only
      // buttons (font size, settings) have no label and are skipped.
      const picker = Array.from(panel.querySelectorAll<HTMLElement>(selector)).find(
        (el) => !region?.contains(el) && pickerLabel(el) !== null,
      );
      if (picker) return picker;
    }
    throw new Error("Couldn't find Meet's caption language picker.");
  }

  /** Opens the picker's menu, hands its options to `use`, then closes it. */
  private async withOpenMenu<T>(
    picker: HTMLElement,
    use: (items: HTMLElement[]) => T,
    { closeAfter = true }: { closeAfter?: boolean } = {},
  ): Promise<T> {
    // Meet may keep the list in the DOM while closed, so "new" means newly *rendered*.
    const before = new Set(Array.from(this.deps.document.querySelectorAll(OPTION_SELECTOR)).filter(isRendered));
    picker.click();
    let items: HTMLElement[] = [];
    const deadline = Date.now() + (this.deps.timeoutMs ?? 1500);
    while (Date.now() < deadline) {
      items = this.menuItems(picker, before);
      if (items.length > 0) break;
      await this.sleep(this.deps.pollMs ?? 100);
    }
    if (items.length === 0) {
      this.closeMenu(picker);
      throw new Error("Meet's caption language list didn't open.");
    }
    try {
      return use(items);
    } finally {
      if (closeAfter) this.closeMenu(picker);
    }
  }

  /** Options of the menu the picker controls, or options that appeared after opening it. */
  private menuItems(picker: HTMLElement, before: ReadonlySet<Element>): HTMLElement[] {
    const doc = this.deps.document;
    const controlled = picker.getAttribute('aria-controls') ?? picker.getAttribute('aria-owns');
    const popup = controlled ? doc.getElementById(controlled) : null;
    const scope: ParentNode = popup ?? doc;
    return Array.from(scope.querySelectorAll<HTMLElement>(OPTION_SELECTOR)).filter(
      (el) => isRendered(el) && (popup !== null || !before.has(el)),
    );
  }

  private closeMenu(picker: HTMLElement): void {
    const doc = this.deps.document;
    const escape = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true } as const;
    (doc.activeElement ?? doc.body).dispatchEvent(new KeyboardEvent('keydown', escape));
    if (picker.getAttribute('aria-expanded') === 'true') picker.click();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function pickerLabel(picker: Element): string | null {
  const text = visibleText(picker);
  return text && !ICON_LIGATURE.test(text) ? text : null;
}

function optionLabel(option: Element): string {
  return visibleText(option);
}

function isLanguageLabel(label: string): boolean {
  return label.length > 0 && label.length <= 60 && !ICON_LIGATURE.test(label);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
