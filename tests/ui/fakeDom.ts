// tests/ui/fakeDom.ts — a minimal, hand-rolled `document` stub for testing browser-oriented panel
// modules (src/ui/*.ts) directly in Node/vitest without a jsdom/happy-dom dependency (repo has
// neither installed; adding one just for this would be disproportionate to what these panels
// actually touch: createElement/appendChild/querySelectorAll/textContent/value/checked/dataset).
//
// Scope is deliberately narrow — only what src/ui/batch-wizard.ts actually calls. This is NOT a
// general jsdom replacement; extend it only when a new panel test needs one more primitive.

export interface FakeElement {
  tagName: string
  id: string
  textContent: string
  className: string
  hidden: boolean
  disabled: boolean
  checked: boolean
  value: string
  type: string
  name: string
  style: Record<string, string>
  dataset: Record<string, string>
  children: FakeElement[]
  parentNode: FakeElement | null
  onclick: (() => void) | null
  onchange: (() => void) | null
  oninput: (() => void) | null
  appendChild<T extends FakeElement>(child: T): T
  removeChild(child: FakeElement): void
  remove(): void
  querySelectorAll(sel: string): FakeElement[]
  querySelector(sel: string): FakeElement | null
}

class FakeElementImpl implements FakeElement {
  tagName: string
  id = ''
  className = ''
  hidden = false
  disabled = false
  checked = false
  value = ''
  type = ''
  name = ''
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  children: FakeElement[] = []
  parentNode: FakeElement | null = null
  onclick: (() => void) | null = null
  onchange: (() => void) | null = null
  oninput: (() => void) | null = null

  private _textContent = ''
  // Real DOM: assigning .textContent replaces all children with a single text node — the whole
  // codebase's panel scripts rely on exactly this ("el.textContent = ''" to clear before
  // rebuilding via appendChild, e.g. src/ui/products-panel.ts's `list.textContent = ''`). A plain
  // string field here would silently diverge from that semantic and leave stale children behind
  // across re-renders, which would make batchWizard.test.ts's beforeEach-reset + re-render flow
  // pass for the wrong reason (or fail confusingly). Mirror the real behavior.
  // Real DOM getter returns concatenated text of ALL descendants — verification tests assert on
  // a container row's textContent containing child line text, so mirror that too.
  get textContent(): string { return this._textContent + this.children.map(c => c.textContent).join('') }
  set textContent(v: string) { this._textContent = v; this.children = [] }

  constructor(tag: string) { this.tagName = tag.toUpperCase() }

  appendChild<T extends FakeElement>(child: T): T {
    child.parentNode = this
    this.children.push(child)
    return child
  }
  removeChild(child: FakeElement): void {
    const i = this.children.indexOf(child)
    if (i !== -1) this.children.splice(i, 1)
  }
  remove(): void { this.parentNode?.removeChild(this) }
  querySelectorAll(sel: string): FakeElement[] { return queryAll(this, sel) }
  querySelector(sel: string): FakeElement | null { return queryAll(this, sel)[0] ?? null }
}

interface ParsedSelector { tag?: string; id?: string; classes: string[]; attrs: Array<{ name: string; value?: string }> }

function parseSelector(sel: string): ParsedSelector {
  let rest = sel.trim()
  const attrs: Array<{ name: string; value?: string }> = []
  const classes: string[] = []
  let id: string | undefined
  rest = rest.replace(/\[([\w-]+)(?:=("[^"]*"|'[^']*'|[^\]]*))?\]/g, (_m, name: string, val: string | undefined) => {
    attrs.push({ name, value: val?.replace(/^['"]|['"]$/g, '') })
    return ''
  })
  rest = rest.replace(/\.([\w-]+)/g, (_m, c: string) => { classes.push(c); return '' })
  rest = rest.replace(/#([\w-]+)/g, (_m, i: string) => { id = i; return '' })
  rest = rest.trim()
  return { tag: rest ? rest.toUpperCase() : undefined, id, classes, attrs }
}

function attrValue(el: FakeElementImpl, name: string): string | undefined {
  if (name === 'type') return el.type || undefined
  if (name === 'name') return el.name || undefined
  if (name === 'disabled') return el.disabled ? 'true' : undefined
  if (name.startsWith('data-')) {
    const key = name.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
    return el.dataset[key]
  }
  return undefined
}

function matches(el: FakeElementImpl, sel: ParsedSelector): boolean {
  if (sel.tag && el.tagName !== sel.tag) return false
  if (sel.id && el.id !== sel.id) return false
  if (sel.classes.some(c => !el.className.split(/\s+/).includes(c))) return false
  for (const a of sel.attrs) {
    const actual = attrValue(el, a.name)
    if (actual === undefined) return false
    if (a.value !== undefined && actual !== a.value) return false
  }
  return true
}

function queryAll(root: FakeElement, selText: string): FakeElement[] {
  const sel = parseSelector(selText)
  const out: FakeElement[] = []
  const walk = (el: FakeElement) => {
    for (const c of el.children) {
      if (matches(c as FakeElementImpl, sel)) out.push(c)
      walk(c)
    }
  }
  walk(root)
  return out
}

export interface FakeDocument {
  getElementById(id: string): FakeElement
  createElement(tag: string): FakeElement
  querySelectorAll(sel: string): FakeElement[]
  body: FakeElement
  // Added for Task 7 apple-design pass: src/ui/batch-wizard.ts injects a single <style> element
  // once via `document.head.appendChild(...)` (real DOM allows <style> in <head> or <body>; head
  // is the conventional target). Only `.appendChild` is needed by that call site — kept as narrow
  // as the rest of this file's "hand-roll only what's used" scope.
  head: FakeElement
}

export function createFakeDocument(): FakeDocument {
  const registry = new Map<string, FakeElement>()
  const body = new FakeElementImpl('BODY')
  const head = new FakeElementImpl('HEAD')
  return {
    getElementById(id: string): FakeElement {
      let el = registry.get(id)
      if (!el) { el = new FakeElementImpl('DIV'); el.id = id; registry.set(id, el) }
      return el
    },
    createElement(tag: string): FakeElement { return new FakeElementImpl(tag) },
    querySelectorAll(sel: string): FakeElement[] { return queryAll(body, sel) },
    body,
    head,
  }
}
