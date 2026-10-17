/**
 * Aho-Corasick keyword matcher — direct TypeScript translation of the reference
 * implementation (sub2api content_moderation_keyword_matcher.go, 222 lines).
 *
 * Build: goto trie over lowercased keyword bytes (UTF-8), BFS failure links
 * with bestKeyword propagation, then compaction into a flat node table
 * (failure / bestKeyword / edgeStart / edgeCount) plus a flat sorted edge
 * array and a 256-slot root transition table. Lookup uses binary search over
 * the per-node sorted edge span.
 *
 * Pure functions / frozen structures: no I/O, no globals, independently
 * unit-testable.
 */

export interface KeywordMatcherNode {
  failure: number;
  bestKeyword: number;
  edgeStart: number;
  edgeCount: number;
}

export interface KeywordMatcherEdge {
  target: number;
  label: number;
}

interface BuildEdge {
  target: number;
  nextSibling: number;
  label: number;
}

export interface KeywordMatcher {
  nodes: KeywordMatcherNode[];
  edges: KeywordMatcherEdge[];
  rootTransitions: Int32Array;
  keywords: string[];
}

const encoder = new TextEncoder();

function toLowerUtf8Bytes(text: string): Uint8Array {
  return encoder.encode(text.toLowerCase());
}

function newNode(): KeywordMatcherNode {
  return { failure: 0, bestKeyword: -1, edgeStart: 0, edgeCount: 0 };
}

function buildFirstEdgeIndex(node: KeywordMatcherNode): number {
  if (node.edgeStart === 0) {
    return -1;
  }
  return node.edgeStart - 1;
}

function buildTransition(nodes: KeywordMatcherNode[], edges: BuildEdge[], state: number, label: number): number {
  if (state < 0 || state >= nodes.length) {
    return -1;
  }
  for (let edgeIndex = buildFirstEdgeIndex(nodes[state]); edgeIndex >= 0; edgeIndex = edges[edgeIndex].nextSibling) {
    if (edges[edgeIndex].label === label) {
      return edges[edgeIndex].target;
    }
  }
  return -1;
}

function minKeywordIndex(left: number, right: number): number {
  if (left < 0) {
    return right;
  }
  if (right < 0 || left < right) {
    return left;
  }
  return right;
}

/**
 * Build a compacted Aho-Corasick automaton over the given keywords.
 * Keywords are matched case-insensitively (all bytes lowercased) and
 * byte-wise over UTF-8, so multi-byte scripts match exactly as in the
 * reference implementation. Returns null when nothing can ever match
 * (no keywords or only empty keywords).
 */
export function buildKeywordMatcher(keywords: readonly string[]): KeywordMatcher | null {
  if (!keywords || keywords.length === 0) {
    return null;
  }

  const buildNodes: KeywordMatcherNode[] = [newNode()];
  const buildEdges: BuildEdge[] = [];
  const originalKeywords = keywords.slice();

  for (let keywordIndex = 0; keywordIndex < keywords.length; keywordIndex++) {
    const keyword = keywords[keywordIndex];
    if (!keyword) {
      continue;
    }
    let state = 0;
    for (const label of toLowerUtf8Bytes(keyword)) {
      let next = buildTransition(buildNodes, buildEdges, state, label);
      if (next < 0) {
        next = buildNodes.length;
        buildNodes.push(newNode());
        buildEdges.push({
          target: next,
          nextSibling: buildFirstEdgeIndex(buildNodes[state]),
          label,
        });
        buildNodes[state].edgeStart = buildEdges.length;
      }
      state = next;
    }
    const current = buildNodes[state].bestKeyword;
    if (current < 0 || keywordIndex < current) {
      buildNodes[state].bestKeyword = keywordIndex;
    }
  }

  if (buildNodes.length === 1) {
    return null;
  }

  const queue: number[] = [];
  const rootTransitions = new Int32Array(256);
  for (
    let edgeIndex = buildFirstEdgeIndex(buildNodes[0]);
    edgeIndex >= 0;
    edgeIndex = buildEdges[edgeIndex].nextSibling
  ) {
    const edge = buildEdges[edgeIndex];
    rootTransitions[edge.label] = edge.target;
    queue.push(edge.target);
  }

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
    const state = queue[queueIndex];
    for (
      let edgeIndex = buildFirstEdgeIndex(buildNodes[state]);
      edgeIndex >= 0;
      edgeIndex = buildEdges[edgeIndex].nextSibling
    ) {
      const edge = buildEdges[edgeIndex];
      let failure = buildNodes[state].failure;
      let fallback = buildTransition(buildNodes, buildEdges, failure, edge.label);
      while (fallback < 0 && failure !== 0) {
        failure = buildNodes[failure].failure;
        fallback = buildTransition(buildNodes, buildEdges, failure, edge.label);
      }
      if (fallback >= 0) {
        buildNodes[edge.target].failure = fallback;
      }
      buildNodes[edge.target].bestKeyword = minKeywordIndex(
        buildNodes[edge.target].bestKeyword,
        buildNodes[buildNodes[edge.target].failure].bestKeyword,
      );
      queue.push(edge.target);
    }
  }

  const edges: KeywordMatcherEdge[] = [];
  const outgoing: KeywordMatcherEdge[] = new Array(256);
  for (let nodeIndex = 0; nodeIndex < buildNodes.length; nodeIndex++) {
    let count = 0;
    for (
      let edgeIndex = buildFirstEdgeIndex(buildNodes[nodeIndex]);
      edgeIndex >= 0;
      edgeIndex = buildEdges[edgeIndex].nextSibling
    ) {
      const edge = buildEdges[edgeIndex];
      outgoing[count] = { target: edge.target, label: edge.label };
      count++;
    }
    for (let index = 1; index < count; index++) {
      const current = outgoing[index];
      let insertAt = index;
      while (insertAt > 0 && current.label < outgoing[insertAt - 1].label) {
        outgoing[insertAt] = outgoing[insertAt - 1];
        insertAt--;
      }
      outgoing[insertAt] = current;
    }
    buildNodes[nodeIndex].edgeStart = edges.length;
    buildNodes[nodeIndex].edgeCount = count;
    for (let i = 0; i < count; i++) {
      edges.push(outgoing[i]);
    }
  }

  return {
    nodes: buildNodes,
    edges,
    rootTransitions,
    keywords: originalKeywords,
  };
}

function matcherNext(matcher: KeywordMatcher, state: number, label: number): number {
  if (state === 0) {
    return matcher.rootTransitions[label];
  }
  if (state < 0 || state >= matcher.nodes.length) {
    return 0;
  }
  const node = matcher.nodes[state];
  let left = node.edgeStart;
  const end = node.edgeStart + node.edgeCount;
  let right = end;
  while (left < right) {
    const middle = left + ((right - left) >> 1);
    const edge = matcher.edges[middle];
    if (edge.label < label) {
      left = middle + 1;
      continue;
    }
    right = middle;
  }
  if (left < end && matcher.edges[left].label === label) {
    return matcher.edges[left].target;
  }
  return 0;
}

export interface KeywordMatchResult {
  keyword: string;
  hit: boolean;
}

const noKeywordMatch: KeywordMatchResult = { keyword: '', hit: false };

/**
 * Match the lowercased UTF-8 bytes of `text` against the automaton.
 * Returns the lowest-index keyword that occurs anywhere in the text.
 */
export function matchKeyword(matcher: KeywordMatcher | null, text: string): KeywordMatchResult {
  if (matcher === null || !text || matcher.nodes.length === 0 || matcher.keywords.length === 0) {
    return noKeywordMatch;
  }
  const lower = toLowerUtf8Bytes(text);
  let state = 0;
  let bestKeyword = -1;
  for (let index = 0; index < lower.length; index++) {
    const label = lower[index];
    for (;;) {
      const next = matcherNext(matcher, state, label);
      if (next !== 0) {
        state = next;
        break;
      }
      if (state === 0) {
        break;
      }
      state = matcher.nodes[state].failure;
    }
    bestKeyword = minKeywordIndex(bestKeyword, matcher.nodes[state].bestKeyword);
    if (bestKeyword === 0) {
      return { keyword: matcher.keywords[0], hit: true };
    }
  }
  if (bestKeyword < 0 || bestKeyword >= matcher.keywords.length) {
    return noKeywordMatch;
  }
  return { keyword: matcher.keywords[bestKeyword], hit: true };
}
