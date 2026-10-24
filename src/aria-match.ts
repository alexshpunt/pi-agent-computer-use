/**
 * Playwright's toMatchAriaSnapshot matching, for native UIA trees and browser pages alike.
 *
 * The template is parsed by Playwright's own parser. The matching functions below are ported from
 * Playwright's packages/injected/src/ariaSnapshot.ts (matchesNode, listEqual, containsList, matchesNodeDeep,
 * matchesTextValue, matchesStringOrRegex), because Playwright ships them only inside its injected page script.
 * Copyright (c) Microsoft Corporation, licensed under the Apache License, Version 2.0
 * (https://www.apache.org/licenses/LICENSE-2.0). Changed: typed, and absent boolean states read as false.
 */
import { createRequire } from "node:module";

/** One node of a received aria tree; strings are text. */
export interface AriaTreeNode {
  role: string; name?: string; children?: (AriaTreeNode | string)[];
  checked?: boolean | "mixed"; pressed?: boolean | "mixed"; disabled?: boolean; expanded?: boolean; selected?: boolean; level?: number;
  props?: { url?: string };
}
interface TextTemplate { raw: string; normalized: string }
interface TemplateNode {
  kind: "role" | "text"; role?: string; name?: string | { pattern: string }; text?: TextTemplate;
  children?: TemplateNode[]; containerMode?: "contain" | "equal" | "deep-equal"; props?: { url?: TextTemplate };
  checked?: boolean | "mixed"; pressed?: boolean | "mixed"; disabled?: boolean; expanded?: boolean; selected?: boolean; level?: number; invalid?: unknown;
}

const load = () => {
  const require = createRequire(import.meta.url);
  const { iso } = require("playwright-core/lib/coreBundle") as { iso: { parseAriaSnapshotUnsafe(yaml: unknown, text: string): TemplateNode } };
  const { yaml } = require("playwright-core/lib/utilsBundle") as { yaml: unknown };
  return (text: string) => iso.parseAriaSnapshotUnsafe(yaml, text);
};
let parser: ((text: string) => TemplateNode) | undefined;

/** Parse an aria snapshot template with Playwright's parser; throws Playwright's message on bad YAML. */
export function parseAriaTemplate(text: string): TemplateNode {
  return (parser ??= load())(text);
}

/** Whether `root` (usually a fragment holding the checked element) contains a subtree matching the template. */
export function matchesAriaTemplate(root: AriaTreeNode, template: string | TemplateNode): boolean {
  return matchesNodeDeep(root, typeof template === "string" ? parseAriaTemplate(template) : template);
}

/** A received YAML snapshot (from a page) as a tree the matcher takes; the result is a fragment of its roots. */
export function ariaTreeFromYaml(text: string): AriaTreeNode {
  const convert = (node: TemplateNode): AriaTreeNode | string => node.kind === "text" ? node.text!.normalized : {
    role: node.role!, ...(typeof node.name === "string" && node.name ? { name: node.name } : {}),
    ...(node.checked !== undefined ? { checked: node.checked } : {}), ...(node.pressed !== undefined ? { pressed: node.pressed } : {}),
    ...(node.disabled ? { disabled: true } : {}), ...(node.expanded ? { expanded: true } : {}), ...(node.selected ? { selected: true } : {}),
    ...(node.level !== undefined ? { level: node.level } : {}), ...(node.props?.url ? { props: { url: node.props.url.normalized } } : {}),
    children: (node.children ?? []).map(convert),
  };
  const parsed = parseAriaTemplate(text);
  return parsed.role === "fragment" ? { role: "fragment", children: (parsed.children ?? []).map(convert) } : { role: "fragment", children: [convert(parsed)] };
}

function matchesStringOrRegex(text: string | undefined, template: TemplateNode["name"]): boolean {
  if (!template) return true;
  if (!text) return false;
  if (typeof template === "string") return text === template;
  return !!text.match(new RegExp(template.pattern));
}

function matchesTextValue(text: string | undefined, template: TextTemplate | undefined): boolean {
  if (!template?.normalized) return true;
  if (!text) return false;
  if (text === template.normalized || text === template.raw) return true;
  const { raw } = template;
  if (!(raw.startsWith("/") && raw.endsWith("/") && raw.length > 1)) return false;
  try { return !!text.match(new RegExp(raw.slice(1, -1))); } catch { return false; }
}

function matchesNode(node: AriaTreeNode | string, template: TemplateNode, isDeepEqual: boolean): boolean {
  if (typeof node === "string" && template.kind === "text") return matchesTextValue(node, template.text);
  if (node === null || typeof node !== "object" || template.kind !== "role") return false;
  if (template.role !== "fragment" && template.role !== node.role) return false;
  if (template.checked !== undefined && template.checked !== node.checked) return false;
  if (template.disabled !== undefined && template.disabled !== (node.disabled ?? false)) return false;
  if (template.expanded !== undefined && template.expanded !== (node.expanded ?? false)) return false;
  if (template.invalid !== undefined) return false;
  if (template.level !== undefined && template.level !== node.level) return false;
  if (template.pressed !== undefined && template.pressed !== node.pressed) return false;
  if (template.selected !== undefined && template.selected !== (node.selected ?? false)) return false;
  if (!matchesStringOrRegex(node.name, template.name)) return false;
  if (!matchesTextValue(node.props?.url, template.props?.url)) return false;
  if (template.containerMode === "contain") return containsList(node.children ?? [], template.children ?? []);
  if (template.containerMode === "equal") return listEqual(node.children ?? [], template.children ?? [], false);
  if (template.containerMode === "deep-equal" || isDeepEqual) return listEqual(node.children ?? [], template.children ?? [], true);
  return containsList(node.children ?? [], template.children ?? []);
}

function listEqual(children: (AriaTreeNode | string)[], template: TemplateNode[], isDeepEqual: boolean): boolean {
  if (template.length !== children.length) return false;
  return template.every((item, index) => matchesNode(children[index], item, isDeepEqual));
}

function containsList(children: (AriaTreeNode | string)[], template: TemplateNode[]): boolean {
  if (template.length > children.length) return false;
  const remaining = children.slice();
  for (const item of template) {
    let child = remaining.shift();
    while (child !== undefined && !matchesNode(child, item, false)) child = remaining.shift();
    if (child === undefined) return false;
  }
  return true;
}

function matchesNodeDeep(root: AriaTreeNode, template: TemplateNode): boolean {
  const visit = (node: AriaTreeNode | string): boolean => matchesNode(node, template, false)
    || (typeof node !== "string" && (node.children ?? []).some(visit));
  return visit(root);
}
