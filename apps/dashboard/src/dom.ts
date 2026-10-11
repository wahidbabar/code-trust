// Element builders. Every string on the page comes from a cross-origin API, so text only ever goes
// in through text nodes: nothing here parses HTML.
type Child = Node | string | false | null | undefined;
type Attrs = Record<string, string | number | boolean | null | undefined>;

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  return fill(document.createElement(tag), attrs, children);
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  return fill(document.createElementNS(SVG_NS, tag), attrs, children);
}

function fill<E extends Element>(element: E, attrs: Attrs, children: Child[]): E {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    element.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    element.append(child);
  }
  return element;
}
