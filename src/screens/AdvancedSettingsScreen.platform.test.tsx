// @ts-nocheck — production JSX with controlled hooks; native runtime checks stay in the release window.
import { expect, test } from 'bun:test';
import { createElement, Fragment } from 'react';
import { readFileSync } from 'node:fs';
import ts from 'typescript6'; // TS 7 (native port) has no in-memory compiler API

const source = readFileSync(new URL('./AdvancedSettingsScreen.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'AdvancedSettingsScreen');
const compiled = ts.transpileModule(declaration.getText(ast).replace(/^export default /, ''), {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
}).outputText;

function render(os) {
  const navigations = [];
  const bindings = {
    React: { createElement, Fragment }, Platform: { OS: os },
    useNavigation: () => ({ navigate: (route) => navigations.push(route), goBack() {} }),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0 }), useTheme: () => ({ colors: {} }),
    useState: (value) => [value, () => {}], useEffect: () => {},
    useCallback: (fn) => fn, useMemo: (fn) => fn(),
    estimatePerformanceStorage: () => ({ estimatedBytes: 0 }), formatBytes: () => '0 B',
    profileCopy: () => 'Loading profile', PROFILES: ['light', 'balanced', 'smooth'],
    PROFILE_LABELS: { light: 'Data saver', balanced: 'Balanced', smooth: 'Smooth' },
    View: 'View', Text: 'Text', ScrollView: 'ScrollView', RefreshControl: 'RefreshControl',
    TouchableOpacity: 'Button', Ionicons: 'Icon', styles: {},
  };
  const Component = new Function(...Object.keys(bindings), `${compiled}; return AdvancedSettingsScreen`)(...Object.values(bindings));
  function elements(node) {
    if (Array.isArray(node)) return node.flatMap(elements);
    return node?.props ? [node, ...elements(node.props.children)] : [];
  }
  return { nodes: elements(Component()), navigations };
}

test('both platforms offer loading profiles; only iOS offers the working quality action', () => {
  for (const os of ['ios', 'android']) {
    const m = render(os);
    const quality = m.nodes.filter((n) => n.props.accessibilityLabel === 'Thumbnail quality settings');
    expect(quality).toHaveLength(os === 'ios' ? 1 : 0);
    for (const label of ['Data saver', 'Balanced', 'Smooth']) {
      expect(m.nodes.some((n) => n.type === 'Text' && n.props.children === label)).toBe(true);
    }
    if (os === 'ios') {
      quality[0].props.onPress();
      expect(m.navigations).toEqual(['ThumbnailQuality']);
    }
  }
});
