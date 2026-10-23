// The renderer's DOM operations only. Live native checks cover browser focus and pixels.
class Node {
  children: Node[] = [];
  parent: Node | null = null;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  handlers: Record<string, () => void> = {};
  textContent = "";
  className = "";
  value = "";
  src = "";
  open = false;
  scrollTop = 0;
  constructor(readonly tag: string) {}
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  append(...nodes: Node[]) {
    for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); }
  }
  replaceChildren(...nodes: Node[]) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  insertBefore(node: Node, before: Node | null) {
    node.remove(); node.parent = this;
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node);
  }
  querySelectorAll(tag: string): Node[] {
    return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]);
  }
  querySelector(tag: string) { return this.querySelectorAll(tag)[0] ?? null; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, handler: () => void) { this.handlers[name] = handler; }
}
/** Create the small DOM used to execute the real viewer renderer in unit tests. */
export function createPanelDom() {
  const nodes = new Map<string, Node>();
  const document = {
    createElement: (tag: string) => new Node(tag),
    getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, new Node("div")); return nodes.get(id)!; },
  };
  return { document, nodes };
}
