/*
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as z from 'zod';

import { defineTabTool } from './tool';
import { elementSchema } from './snapshot';

import type { CDPSession, Locator } from '../../..';
import type { Protocol } from '../../server/chromium/protocol';
import type { Tab } from './tab';

const pseudoStates = ['hover', 'focus', 'focus-visible', 'focus-within', 'active', 'visited'] as const;

type RuleRecord = {
  match: Protocol.CSS.RuleMatch;
  selector: string;
  specificity: [number, number, number];
  source: string;
  line: number;
  contexts: string[];
  sheetOrder: number;
  sourceLine: number;
  sourceColumn: number;
  matchOrder: number;
  layerOrder: number[];
};

type StyleSource = {
  style: Protocol.CSS.CSSStyle;
  isInline: boolean;
  origin: Protocol.CSS.CSSRule['origin'];
  specificity: [number, number, number];
  layered: boolean;
  layerOrder: number[];
  sheetOrder: number;
  sourceLine: number;
  sourceColumn: number;
  declarationOrder: number;
  rule?: RuleRecord;
};

type CascadeCandidate = {
  declaration: Protocol.CSS.CSSProperty;
  source: StyleSource;
};

function normalizeProperty(name: string): string {
  return name.startsWith('--') ? name : name.toLowerCase();
}

// CDP lists the authored declarations (with a source range) plus parsed duplicates and
// shorthand longhands without one. Show authored text when the style has any; otherwise
// (e.g. CSSOM-inserted rules) fall back to one entry per property, last one wins.
function visibleDeclarations(style: Protocol.CSS.CSSStyle, properties?: Set<string>): Protocol.CSS.CSSProperty[] {
  const usable = style.cssProperties.filter(declaration => !declaration.disabled && declaration.parsedOk !== false);
  let declarations = usable.filter(declaration => declaration.range);
  if (!declarations.length) {
    const byName = new Map<string, Protocol.CSS.CSSProperty>();
    for (const declaration of usable)
      byName.set(normalizeProperty(declaration.name), declaration);
    declarations = [...byName.values()];
  }
  return properties ? declarations.filter(declaration => properties.has(normalizeProperty(declaration.name))) : declarations;
}

function specificityFor(rule: Protocol.CSS.CSSRule, matchingSelectors: number[]): [number, number, number] {
  let best: [number, number, number] = [0, 0, 0];
  for (const index of matchingSelectors) {
    const specificity = rule.selectorList.selectors[index]?.specificity;
    if (!specificity)
      continue;
    const current: [number, number, number] = [specificity.a, specificity.b, specificity.c];
    if (current[0] > best[0] || current[0] === best[0] && current[1] > best[1] ||
        current[0] === best[0] && current[1] === best[1] && current[2] > best[2])
      best = current;
  }
  return best;
}

function ruleContexts(rule: Protocol.CSS.CSSRule): string[] {
  return [
    ...(rule.media || []).map(media => `@media ${media.text}`),
    ...(rule.supports || []).map(supports => `@supports ${supports.text}`),
    ...(rule.layers || []).map(layer => `@layer ${layer.text || '<anonymous>'}`),
    ...(rule.containerQueries || []).map(query => `@container ${[query.name, query.conditionText || query.text].filter(Boolean).join(' ')}`),
    ...(rule.scopes || []).map(scope => `@scope ${scope.text}`),
  ];
}
function makeLayerOrderMap(rootLayer: Protocol.CSS.CSSLayerData): Map<string, number[]> {
  const orders = new Map<string, number[]>();
  const visit = (layer: Protocol.CSS.CSSLayerData, parentNames: string[], parentOrders: number[]) => {
    const names = layer.name ? [...parentNames, layer.name] : parentNames;
    const layerOrder = layer.name ? [...parentOrders, layer.order] : parentOrders;
    if (names.length)
      orders.set(names.join('.'), layerOrder);
    for (const subLayer of layer.subLayers || [])
      visit(subLayer, names, layerOrder);
  };
  for (const subLayer of rootLayer.subLayers || [])
    visit(subLayer, [], []);
  if (!rootLayer.subLayers?.length && rootLayer.name)
    visit(rootLayer, [], []);
  return orders;
}

function layerOrderFor(rule: Protocol.CSS.CSSRule, layerOrders: Map<string, number[]>): number[] {
  let path: string[] = [];
  let order: number[] = [];
  for (const layer of [...(rule.layers || [])].reverse()) {
    const name = layer.text.trim();
    if (!name)
      continue;
    path = name.includes('.') ? name.split('.') : [...path, name];
    const currentOrder = layerOrders.get(path.join('.'));
    if (currentOrder)
      order = currentOrder;
  }
  return order;
}


function makeRuleRecords(
  matches: Protocol.CSS.RuleMatch[],
  styleSheets: Map<string, { header: Protocol.CSS.CSSStyleSheetHeader, order: number }>,
  includeUserAgent: boolean,
  layerOrders: Map<string, number[]>
): RuleRecord[] {
  const records: RuleRecord[] = [];
  for (let matchOrder = 0; matchOrder < matches.length; matchOrder++) {
    const match = matches[matchOrder];
    const rule = match.rule;
    if (!includeUserAgent && rule.origin === 'user-agent')
      continue;

    const matchingSelectors = match.matchingSelectors || [];
    const selectors = matchingSelectors
        .map(index => rule.selectorList.selectors[index]?.text)
        .filter((selector): selector is string => !!selector);
    const range = rule.style.range;
    const sourceLine = range?.startLine || 0;
    const sourceColumn = range?.startColumn || 0;
    const styleSheet = rule.styleSheetId ? styleSheets.get(rule.styleSheetId) : undefined;
    const header = styleSheet?.header;
    const source = rule.origin === 'user-agent' ? 'user agent stylesheet' :
      rule.origin === 'inspector' ? 'inspector stylesheet' :
        header?.isInline ? 'inline <style>' : header?.sourceURL || 'inline <style>';

    records.push({
      match,
      selector: selectors.length ? selectors.join(', ') : rule.selectorList.text,
      specificity: specificityFor(rule, matchingSelectors),
      source,
      line: sourceLine + (header?.isInline ? header.startLine : 0) + 1,
      contexts: ruleContexts(rule),
      sheetOrder: styleSheet?.order ?? matchOrder,
      sourceLine,
      sourceColumn,
      matchOrder,
      layerOrder: layerOrderFor(rule, layerOrders),
    });
  }
  return records;
}

function sourceForRule(record: RuleRecord): StyleSource {
  const rule = record.match.rule;
  return {
    style: rule.style,
    isInline: false,
    origin: rule.origin,
    specificity: record.specificity,
    layered: !!rule.layers?.length,
    layerOrder: record.layerOrder,
    sheetOrder: record.sheetOrder,
    sourceLine: record.sourceLine,
    sourceColumn: record.sourceColumn,
    declarationOrder: record.matchOrder,
    rule: record,
  };
}

function compareSourceOrder(a: StyleSource, b: StyleSource): number {
  return a.sheetOrder - b.sheetOrder || a.sourceLine - b.sourceLine ||
    a.sourceColumn - b.sourceColumn || a.declarationOrder - b.declarationOrder;
}
function compareLayerPriority(a: StyleSource, b: StyleSource, important: boolean): number {
  if (a.layered !== b.layered)
    return important ? Number(a.layered) - Number(b.layered) : Number(b.layered) - Number(a.layered);
  if (!a.layered)
    return 0;

  const depth = Math.max(a.layerOrder.length, b.layerOrder.length);
  for (let index = 0; index < depth; index++) {
    const aOrder = a.layerOrder[index] ?? Number.MAX_SAFE_INTEGER;
    const bOrder = b.layerOrder[index] ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder)
      return important ? bOrder - aOrder : aOrder - bOrder;
  }
  return 0;
}


function originPriority(origin: Protocol.CSS.CSSRule['origin'], important: boolean): number {
  if (origin === 'user-agent')
    return important ? 3 : 0;
  if (origin === 'inspector')
    return important ? 2 : 3;
  return important ? 1 : 2;
}

function compareCascadePriority(a: CascadeCandidate, b: CascadeCandidate): number {
  const aImportant = !!a.declaration.important;
  const bImportant = !!b.declaration.important;
  if (aImportant !== bImportant)
    return Number(aImportant) - Number(bImportant);

  const originDifference = originPriority(a.source.origin, aImportant) - originPriority(b.source.origin, bImportant);
  if (originDifference)
    return originDifference;

  const layerDifference = compareLayerPriority(a.source, b.source, aImportant);
  if (layerDifference)
    return layerDifference;

  if (a.source.isInline !== b.source.isInline)
    return Number(a.source.isInline) - Number(b.source.isInline);

  for (let index = 0; index < 3; index++) {
    if (a.source.specificity[index] !== b.source.specificity[index])
      return a.source.specificity[index] - b.source.specificity[index];
  }
  return compareSourceOrder(a.source, b.source);
}

function candidatesForSources(sources: StyleSource[], properties?: Set<string>): CascadeCandidate[] {
  const candidates: CascadeCandidate[] = [];
  for (const source of sources) {
    for (const declaration of visibleDeclarations(source.style, properties))
      candidates.push({ declaration, source });
  }
  return candidates;
}

function winningDeclarations(candidates: CascadeCandidate[]): Set<Protocol.CSS.CSSProperty> {
  const sorted = [...candidates].sort((a, b) => compareCascadePriority(b, a));
  const seen = new Set<string>();
  const winners = new Set<Protocol.CSS.CSSProperty>();
  for (const candidate of sorted) {
    const property = normalizeProperty(candidate.declaration.name);
    if (seen.has(property))
      continue;
    seen.add(property);
    winners.add(candidate.declaration);
  }
  return winners;
}

// Chrome returns matched rules in ascending cascade order; print highest priority first like DevTools.
function sortedRules(records: RuleRecord[]): RuleRecord[] {
  return [...records].sort((a, b) => b.matchOrder - a.matchOrder);
}

function safeComment(value: string): string {
  return value.replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' ');
}

function appendStyleBlock(
  output: string[],
  selector: string,
  style: Protocol.CSS.CSSStyle,
  winners: Set<Protocol.CSS.CSSProperty>,
  properties?: Set<string>
): void {
  const declarations = visibleDeclarations(style, properties);
  if (!declarations.length)
    return;
  output.push(`${selector} {`);
  for (const declaration of declarations) {
    const value = declaration.value.replace(/\s*!important\s*$/i, '');
    const important = declaration.important ? ' !important' : '';
    const overridden = winners.has(declaration) ? '' : ' /* overridden */';
    output.push(`  ${declaration.name}: ${value}${important};${overridden}`);
  }
  output.push('}');
}

function appendRule(
  output: string[],
  record: RuleRecord,
  winners: Set<Protocol.CSS.CSSProperty>,
  properties?: Set<string>
): void {
  const rule = record.match.rule;
  if (!visibleDeclarations(rule.style, properties).length)
    return;
  output.push(`/* ${safeComment(record.source)}:${record.line} */`);
  if (record.contexts.length)
    output.push(`/* ${record.contexts.map(safeComment).join('; ')} */`);
  appendStyleBlock(output, record.selector, rule.style, winners, properties);
}

function ancestorDescriptions(locator: Locator): Promise<string[]> {
  return locator.evaluate(element => {
    const ancestors: string[] = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const tag = parent.tagName.toLowerCase();
      const id = parent.id ? `#${parent.id}` : '';
      const classes = Array.from(parent.classList, name => `.${name}`).join('');
      ancestors.push(`${tag}${id}${classes}`);
    }
    return ancestors;
  });
}

async function resolveNodeId(
  session: CDPSession,
  locator: Locator
): Promise<Protocol.DOM.NodeId> {
  const key = `__pw_mcp_css_rules_${Math.random().toString(36).slice(2)}`;
  const objectGroup = key;
  await locator.evaluate((element, property) => {
    Object.defineProperty(window, property, { value: element, configurable: true });
  }, key);

  try {
    // DOM.requestNode only works after the client has requested the document in this session.
    await session.send('DOM.getDocument', { depth: 0 });
    const evaluated = await session.send('Runtime.evaluate', {
      expression: `window[${JSON.stringify(key)}]`,
      objectGroup,
      silent: true,
    });
    if (evaluated.exceptionDetails || !evaluated.result.objectId)
      throw new Error('no CDP object was returned for the target');
    const requested = await session.send('DOM.requestNode', { objectId: evaluated.result.objectId });
    if (!requested.nodeId)
      throw new Error('no CDP node was returned for the target');
    return requested.nodeId;
  } catch (error) {
    throw new Error(`Could not resolve the target to a CDP node (${error instanceof Error ? error.message : String(error)}). Targets inside out-of-process iframes are not supported.`);
  } finally {
    await session.send('Runtime.evaluate', {
      expression: `delete window[${JSON.stringify(key)}]`,
      silent: true,
    }).catch(() => {});
    await locator.evaluate((_element, property) => {
      Reflect.deleteProperty(window, property);
    }, key).catch(() => {});
    await session.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {});
  }
}


async function readComputedStyle(
  locator: Locator,
  properties: string[],
  pseudo?: string
): Promise<Map<string, string>> {
  const values = await locator.evaluate((element, args) => {
    const style = window.getComputedStyle(element, args.pseudo);
    return args.properties.map(property => [property, style.getPropertyValue(property)] as [string, string]);
  }, { properties, pseudo });
  return new Map(values);
}

const cssRules = defineTabTool({
  capability: 'styles',
  schema: {
    name: 'browser_css_rules',
    title: 'Authored CSS rules',
    description: 'Inspect element CSS: cascade, computed styles. Chromium only.',
    inputSchema: elementSchema.extend({
      pseudoState: z.array(z.enum(pseudoStates)).optional().describe('Pseudo states to force while collecting rules.'),
      includeInherited: z.boolean().optional().default(false).describe('Include rules from ancestor elements.'),
      includeUserAgent: z.boolean().optional().default(false).describe('Include user-agent stylesheet rules.'),
      properties: z.array(z.string()).optional().describe('Limit each section to these CSS properties.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab: Tab, params, response) => {
    const browser = tab.page.context().browser();
    if (browser?.browserType().name() !== 'chromium') {
      response.addError('browser_css_rules is only supported in Chromium (Chrome, Microsoft Edge, or Chromium).');
      return;
    }

    const { locator } = await tab.targetLocator(params);
    const session = await tab.page.context().newCDPSession(tab.page);
    const styleSheets = new Map<string, { header: Protocol.CSS.CSSStyleSheetHeader, order: number }>();
    let nextSheetOrder = 0;
    const onStyleSheetAdded = (event: Protocol.CSS.styleSheetAddedPayload) => {
      styleSheets.set(event.header.styleSheetId, { header: event.header, order: nextSheetOrder++ });
    };
    session.on('CSS.styleSheetAdded', onStyleSheetAdded);

    let forcedPseudoState = false;
    let forcedNodeId: Protocol.DOM.NodeId | undefined;
    try {
      await session.send('Runtime.enable');
      await session.send('DOM.enable');
      await session.send('CSS.enable');

      const nodeId = await resolveNodeId(session, locator);
      forcedNodeId = nodeId;
      if (params.pseudoState !== undefined) {
        forcedPseudoState = true;
        await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: params.pseudoState });
      }

      const [matched, computed, layers] = await Promise.all([
        session.send('CSS.getMatchedStylesForNode', { nodeId }),
        session.send('CSS.getComputedStyleForNode', { nodeId }),
        session.send('CSS.getLayersForNode', { nodeId }),
      ]);
      const layerOrders = makeLayerOrderMap(layers.rootLayer);
      const propertyFilter = params.properties === undefined ? undefined : new Set(params.properties.map(normalizeProperty));
      const baseRules = makeRuleRecords(matched.matchedCSSRules || [], styleSheets, params.includeUserAgent, layerOrders);
      const inlineSource: StyleSource | undefined = matched.inlineStyle ? {
        style: matched.inlineStyle,
        isInline: true,
        origin: 'regular',
        specificity: [0, 0, 0],
        layered: false,
        layerOrder: [],
        sheetOrder: Number.MAX_SAFE_INTEGER,
        sourceLine: 0,
        sourceColumn: 0,
        declarationOrder: 0,
      } : undefined;
      const baseRuleSources = baseRules.map(sourceForRule);
      const baseSources = [...(inlineSource ? [inlineSource] : []), ...baseRuleSources];
      const baseCandidates = candidatesForSources(baseSources, propertyFilter);
      const baseWinners = winningDeclarations(baseCandidates);
      const baseProperties = new Set(baseCandidates.map(candidate => candidate.declaration.name));

      const output: string[] = [];
      if (inlineSource)
        appendStyleBlock(output, 'element.style', inlineSource.style, baseWinners, propertyFilter);
      for (const record of sortedRules(baseRules))
        appendRule(output, record, baseWinners, propertyFilter);

      const pseudoOutputs: { selector: string, properties: string[] }[] = [];
      for (const pseudo of matched.pseudoElements || []) {
        const pseudoLabel = `::${pseudo.pseudoType}${pseudo.pseudoIdentifier ? `(${pseudo.pseudoIdentifier})` : ''}`;
        const records = makeRuleRecords(pseudo.matches, styleSheets, params.includeUserAgent, layerOrders);
        const sources = records.map(sourceForRule);
        const candidates = candidatesForSources(sources, propertyFilter);
        if (!candidates.length)
          continue;
        const winners = winningDeclarations(candidates);
        output.push(`/* pseudo-element ${safeComment(pseudoLabel)} */`);
        for (const record of sortedRules(records))
          appendRule(output, record, winners, propertyFilter);
        pseudoOutputs.push({
          selector: records[0]?.selector || `element${pseudoLabel}`,
          properties: [...new Set(candidates.map(candidate => candidate.declaration.name))],
        });
      }

      if (params.includeInherited) {
        const inheritedEntries = matched.inherited || [];
        const ancestors = await ancestorDescriptions(locator);
        const alreadySpecified = new Set(baseCandidates.map(candidate => normalizeProperty(candidate.declaration.name)));
        for (let index = 0; index < inheritedEntries.length; index++) {
          const inherited = inheritedEntries[index];
          const records = makeRuleRecords(inherited.matchedCSSRules || [], styleSheets, params.includeUserAgent, layerOrders);
          const inlineInherited: StyleSource | undefined = inherited.inlineStyle ? {
            style: inherited.inlineStyle,
            isInline: true,
            origin: 'regular',
            specificity: [0, 0, 0],
            layered: false,
            layerOrder: [],
            sheetOrder: Number.MAX_SAFE_INTEGER,
            sourceLine: 0,
            sourceColumn: 0,
            declarationOrder: 0,
          } : undefined;
          const sources = [...(inlineInherited ? [inlineInherited] : []), ...records.map(sourceForRule)];
          const candidates = candidatesForSources(sources, propertyFilter);
          if (!candidates.length)
            continue;

          const levelWinners = winningDeclarations(candidates);
          const visibleWinners = new Set([...levelWinners].filter(declaration => !alreadySpecified.has(normalizeProperty(declaration.name))));
          const ancestor = safeComment(ancestors[index] || 'ancestor');
          output.push(`/* inherited from ${ancestor} */`);
          if (inlineInherited)
            appendStyleBlock(output, 'element.style', inlineInherited.style, visibleWinners, propertyFilter);
          for (const record of sortedRules(records))
            appendRule(output, record, visibleWinners, propertyFilter);
          for (const candidate of candidates)
            alreadySpecified.add(normalizeProperty(candidate.declaration.name));
          for (const candidate of candidates)
            baseProperties.add(candidate.declaration.name);
        }
      }

      const computedPseudoOutputs: { selector: string, names: string[], values: Map<string, string> }[] = [];
      for (const pseudo of pseudoOutputs) {
        const names = pseudo.properties.sort((a, b) => a.localeCompare(b));
        const pseudoElement = pseudo.selector.slice(pseudo.selector.lastIndexOf('::'));
        const values = await readComputedStyle(locator, names, pseudoElement);
        computedPseudoOutputs.push({ selector: pseudo.selector, names, values });
      }

      const computedValues = new Map(computed.computedStyle.map(property => [property.name, property.value] as const));
      const baseNames = [...baseProperties].sort((a, b) => a.localeCompare(b));
      const fallbackValues = await readComputedStyle(locator, baseNames);
      output.push('/* computed */');
      output.push('element {');
      for (const name of baseNames)
        output.push(`  ${name}: ${computedValues.get(name) ?? fallbackValues.get(name) ?? ''};`);
      output.push('}');

      for (const pseudo of computedPseudoOutputs) {
        output.push(`${pseudo.selector} {`);
        for (const name of pseudo.names)
          output.push(`  ${name}: ${pseudo.values.get(name) ?? ''};`);
        output.push('}');
      }

      response.addTextResult(output.join('\n'));
    } finally {
      if (forcedPseudoState && forcedNodeId !== undefined)
        await session.send('CSS.forcePseudoState', { nodeId: forcedNodeId, forcedPseudoClasses: [] }).catch(() => {});
      session.off('CSS.styleSheetAdded', onStyleSheetAdded);
      await session.detach().catch(() => {});
    }
  },
});

export default [cssRules];
