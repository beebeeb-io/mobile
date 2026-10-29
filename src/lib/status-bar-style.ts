/**
 * Status-bar content style — follows the BACKGROUND the bar sits on, not the
 * app theme alone (task 1591, bug 1).
 *
 * The root `<StatusBar>` in App.tsx picks its style from the app theme
 * (`resolved === 'dark' ? 'light' : 'dark'`). That is right for every themed
 * screen, and wrong for the screens whose background is dark regardless of
 * the theme: the photo/video/RAW preview (a fixed near-black media stage) and
 * the code/text surfaces (CodeRenderer + TextEditorView paint a fixed
 * `#282c34`). In the light theme those screens inherited DARK status-bar
 * text on a dark ground — the clock was nearly invisible in the App Store
 * captures (`_qa-evidence/1573/captures/iphone-03-photo-preview.png`,
 * `iphone-05-editor.png`).
 */

export type StatusBarContentStyle = 'light' | 'dark';

/** Light content on a dark background, dark content on a light one. */
export function statusBarStyleFor(backgroundIsDark: boolean): StatusBarContentStyle {
  return backgroundIsDark ? 'light' : 'dark';
}

export interface PreviewSurfaceInput {
  /** Image / video / RAW — the fixed near-black media stage. */
  isMediaPreview: boolean;
  /** The file previews as text (code, plain text, markdown). */
  isText: boolean;
  /** The text editor (TextEditorView, fixed dark) is showing. */
  editMode: boolean;
  /** The text has loaded, so the read-only renderer is on screen. */
  textLoaded: boolean;
  isMarkdown: boolean;
  /** Markdown's "Show source" — raw text through the (dark) CodeRenderer. */
  showSource: boolean;
  /** The app's resolved theme. */
  appScheme: 'light' | 'dark';
}

/**
 * Is the surface directly under the preview's status bar dark?
 *
 * - media stage: always dark;
 * - text editor: always dark;
 * - loaded text shown through CodeRenderer (plain text, code, markdown with
 *   "Show source"): always dark;
 * - rendered markdown, documents, PDFs, loading/error states: the themed
 *   `c.paper` root, so it follows the app theme.
 */
export function previewSurfaceIsDark(input: PreviewSurfaceInput): boolean {
  if (input.isMediaPreview) return true;
  if (input.isText) {
    if (input.editMode) return true;
    if (input.textLoaded && !(input.isMarkdown && !input.showSource)) return true;
  }
  return input.appScheme === 'dark';
}
