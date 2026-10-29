/**
 * Task 1821: finds purchase vocabulary in every string a person can read.
 *
 * App Store 3.1.1 / 3.1.3 (task 1400): the iOS binary shows account STATE only.
 * No plan names as products to buy, no prices, no "subscribe / upgrade / choose
 * your plan / manage it on the web" hints, no links to purchase. The scan walks
 * the TypeScript AST of one source file and returns every string literal, template
 * piece and JSX text that carries that vocabulary. It lives in scripts/ (not src/)
 * so the vocabulary below is not itself scanned.
 */
import ts from 'typescript';

/** Words that are purchase vocabulary wherever they appear in a visible string. */
const ALWAYS =
  /subscri(be|bed|ption|ptions)|upgrad|\bplans?\b|\bprices?\b|\bpricing\b|\bpay(ment|ments|ing|s)?\b|\bbuy\b|\bpurchas|\bcheckout\b|\bbilling\b|\bbilled\b|\brenew|€|\$\s?\d|per (month|year)|\/(mo|yr)\b|choose (a|your) plan/i;

/** "on the web" is a purchase hint only next to a plan, money or management word. */
const WEB_HINT =
  /(manage|plan|subscri|pay|upgrade|price|buy|billing|trial|resume).{0,60}on the web|on the web.{0,60}(manage|plan|subscri|pay|upgrade|price|buy|billing|trial)/i;

export interface Hit {
  file: string;
  line: number;
  text: string;
}

/** Normalised text of a string the person can read (not a code, id or path). */
function visible(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  // Machine strings: no whitespace and not a capitalised word ("needs_plan", "/billing/x", "plan_name").
  if (!/\s/.test(t) && !/^[A-Z][a-z]+$/.test(t)) return null;
  return t;
}

export function isPurchaseWording(t: string): boolean {
  return ALWAYS.test(t) || WEB_HINT.test(t);
}

export function scanSource(file: string, source: string): Hit[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: Hit[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isLiteralTypeNode(n) || ts.isTypeReferenceNode(n)) return;
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isJsxText(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      const t = visible(n.text);
      if (t && isPurchaseWording(t)) {
        hits.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: t });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}
