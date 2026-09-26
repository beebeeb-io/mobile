// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1563 — markdown tokenizer/renderer MAPPING tests: `parseMarkdown()`
// walks `marked`'s lexer output into Beebeeb's own `MdBlock`/`MdInline`
// nodes (`./types.ts`). No react-native dependency at all (pure `marked` +
// this module), so no `mock.module` boilerplate is needed here.
import { describe, expect, test } from 'bun:test'
import { parseMarkdown } from './parse'
import type { MdBlock } from './types'

describe('parseMarkdown — headings, paragraphs, bold/italic', () => {
  test('maps a heading to the right depth and inline text', () => {
    const blocks = parseMarkdown('## Section title')
    expect(blocks).toEqual([{ kind: 'heading', depth: 2, inline: [{ kind: 'text', text: 'Section title' }] }])
  })

  test('clamps an absurd depth (defensive — marked never emits >6, but the type says 1..6)', () => {
    // hljs/marked's grammar caps at 6 '#' anyway; this proves OUR clamp, not marked's.
    const blocks = parseMarkdown('###### deepest')
    expect((blocks[0] as Extract<MdBlock, { kind: 'heading' }>).depth).toBe(6)
  })

  test('maps bold and italic inside a paragraph to nested inline nodes', () => {
    const blocks = parseMarkdown('Some **bold** and *italic* text.')
    expect(blocks).toEqual([
      {
        kind: 'paragraph',
        inline: [
          { kind: 'text', text: 'Some ' },
          { kind: 'bold', children: [{ kind: 'text', text: 'bold' }] },
          { kind: 'text', text: ' and ' },
          { kind: 'italic', children: [{ kind: 'text', text: 'italic' }] },
          { kind: 'text', text: ' text.' },
        ],
      },
    ])
  })

  test('maps inline code (codespan) to a code node, not a text node', () => {
    const blocks = parseMarkdown('Run `bun test` now.')
    const para = blocks[0] as Extract<MdBlock, { kind: 'paragraph' }>
    expect(para.inline).toContainEqual({ kind: 'code', text: 'bun test' })
  })

  test('maps a link to href + inline children', () => {
    const blocks = parseMarkdown('[Beebeeb](https://beebeeb.io)')
    const para = blocks[0] as Extract<MdBlock, { kind: 'paragraph' }>
    expect(para.inline).toEqual([
      { kind: 'link', href: 'https://beebeeb.io', children: [{ kind: 'text', text: 'Beebeeb' }] },
    ])
  })

  test('maps strikethrough (GFM del) to a strike node', () => {
    const blocks = parseMarkdown('~~gone~~')
    const para = blocks[0] as Extract<MdBlock, { kind: 'paragraph' }>
    expect(para.inline).toEqual([{ kind: 'strike', children: [{ kind: 'text', text: 'gone' }] }])
  })
})

describe('parseMarkdown — lists + GFM task lists', () => {
  test('maps a plain unordered list', () => {
    const blocks = parseMarkdown('- one\n- two\n')
    expect(blocks).toEqual([
      {
        kind: 'list',
        list: {
          ordered: false,
          start: 1,
          items: [
            { inline: [{ kind: 'text', text: 'one' }], task: false, checked: false, sublist: null },
            { inline: [{ kind: 'text', text: 'two' }], task: false, checked: false, sublist: null },
          ],
        },
      },
    ])
  })

  test('maps an ordered list honoring a non-1 start number', () => {
    const blocks = parseMarkdown('5. five\n6. six\n')
    const list = (blocks[0] as Extract<MdBlock, { kind: 'list' }>).list
    expect(list.ordered).toBe(true)
    expect(list.start).toBe(5)
  })

  test('maps a GFM task list — checked and unchecked items carry task+checked, no stray checkbox inline node', () => {
    const blocks = parseMarkdown('- [ ] todo\n- [x] done\n')
    const list = (blocks[0] as Extract<MdBlock, { kind: 'list' }>).list
    expect(list.items).toEqual([
      { inline: [{ kind: 'text', text: 'todo' }], task: true, checked: false, sublist: null },
      { inline: [{ kind: 'text', text: 'done' }], task: true, checked: true, sublist: null },
    ])
  })

  test('maps one level of nested sub-list onto the parent item', () => {
    const blocks = parseMarkdown('- parent\n  - child a\n  - child b\n')
    const list = (blocks[0] as Extract<MdBlock, { kind: 'list' }>).list
    expect(list.items).toHaveLength(1)
    const parent = list.items[0]!
    expect(parent.inline).toEqual([{ kind: 'text', text: 'parent' }])
    expect(parent.sublist?.items.map((i) => i.inline)).toEqual([
      [{ kind: 'text', text: 'child a' }],
      [{ kind: 'text', text: 'child b' }],
    ])
  })
})

describe('parseMarkdown — blockquotes, fenced code, tables, hr', () => {
  test('maps a blockquote to nested blocks (recursive)', () => {
    const blocks = parseMarkdown('> a quote\n> with two lines\n')
    expect(blocks[0]?.kind).toBe('blockquote')
    const bq = blocks[0] as Extract<MdBlock, { kind: 'blockquote' }>
    expect(bq.blocks).toEqual([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'a quote\nwith two lines' }] },
    ])
  })

  test('maps a fenced code block with its language tag', () => {
    const blocks = parseMarkdown('```ts\nconst x = 1;\n```')
    expect(blocks).toEqual([{ kind: 'code', lang: 'ts', text: 'const x = 1;' }])
  })

  test('a fenced code block with no language tag maps lang to null, not empty string', () => {
    const blocks = parseMarkdown('```\nplain\n```')
    expect((blocks[0] as Extract<MdBlock, { kind: 'code' }>).lang).toBeNull()
  })

  test('maps a GFM table with header, rows, and per-column alignment', () => {
    const blocks = parseMarkdown('| A | B |\n|:--|--:|\n| 1 | 2 |\n')
    expect(blocks).toEqual([
      {
        kind: 'table',
        align: ['left', 'right'],
        header: [[{ kind: 'text', text: 'A' }], [{ kind: 'text', text: 'B' }]],
        rows: [[[{ kind: 'text', text: '1' }], [{ kind: 'text', text: '2' }]]],
      },
    ])
  })

  test('maps a thematic break to an hr node', () => {
    const blocks = parseMarkdown('above\n\n---\n\nbelow')
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'hr', 'paragraph'])
  })
})

describe('parseMarkdown — out-of-scope tokens are dropped, not mis-rendered', () => {
  test('drops raw inline/block HTML instead of emitting a broken node', () => {
    const blocks = parseMarkdown('<div>raw html</div>\n\nAfter.')
    // No 'html'-kind node anywhere in the tree, and the real paragraph survives.
    expect(blocks.some((b) => (b as { kind: string }).kind === 'html')).toBe(false)
    expect(blocks.some((b) => b.kind === 'paragraph')).toBe(true)
  })
})
