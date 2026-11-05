// The monitor hierarchy is a DAG: a monitor may have several parents.
// Edges are stored once (parent -> child); "dependents" are just the
// reverse view, so adding a parent automatically lists the monitor as that
// parent's dependent.

export class Graph {
  constructor(ids, edges) {
    this.ids = [...ids];
    this.parents = new Map(this.ids.map((id) => [id, new Set()]));
    this.children = new Map(this.ids.map((id) => [id, new Set()]));
    for (const { parentId, childId } of edges) {
      if (!this.parents.has(childId) || !this.children.has(parentId)) continue;
      this.parents.get(childId).add(parentId);
      this.children.get(parentId).add(childId);
    }
  }

  parentsOf(id) {
    return [...(this.parents.get(id) ?? [])];
  }

  childrenOf(id) {
    return [...(this.children.get(id) ?? [])];
  }

  roots() {
    return this.ids.filter((id) => this.parents.get(id).size === 0);
  }

  // Breadth-first, so nearer descendants come first. Excludes `id` itself.
  descendants(id) {
    return this.#walk(id, this.children);
  }

  ancestors(id) {
    return this.#walk(id, this.parents);
  }

  #walk(start, adj) {
    const seen = new Set([start]);
    const out = [];
    const queue = [...(adj.get(start) ?? [])];
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      queue.push(...(adj.get(id) ?? []));
    }
    return out;
  }

  // Adding parent -> child creates a cycle if the parent is already
  // downstream of the child (or they are the same monitor).
  wouldCycle(parentId, childId) {
    return parentId === childId || this.descendants(childId).includes(parentId);
  }

  // Kahn's algorithm: if some node never reaches in-degree 0, there's a loop.
  hasCycle() {
    const indeg = new Map(this.ids.map((id) => [id, this.parents.get(id).size]));
    const queue = this.ids.filter((id) => indeg.get(id) === 0);
    let seen = 0;
    while (queue.length) {
      const id = queue.shift();
      seen++;
      for (const c of this.children.get(id)) {
        indeg.set(c, indeg.get(c) - 1);
        if (indeg.get(c) === 0) queue.push(c);
      }
    }
    return seen !== this.ids.length;
  }

  // Level = length of the longest path from a root. Roots are level 0, and a
  // child always sits strictly below every one of its parents.
  levels() {
    const level = new Map();
    const visit = (id, stack = new Set()) => {
      if (level.has(id)) return level.get(id);
      if (stack.has(id)) return 0; // defensive: cycles are rejected on write
      stack.add(id);
      let l = 0;
      for (const p of this.parents.get(id)) l = Math.max(l, visit(p, stack) + 1);
      stack.delete(id);
      level.set(id, l);
      return l;
    };
    for (const id of this.ids) visit(id);
    return level;
  }

  // Depth-first listing of everything under `rootId` for which `include`
  // returns true, each monitor once, with its depth below the root. Used to
  // render the "other affected monitors" tree in an alert body.
  subtree(rootId, include = () => true, sortKey = (id) => id) {
    const seen = new Set([rootId]);
    const out = [];
    const visit = (id, depth) => {
      const kids = this.childrenOf(id).sort((a, b) => String(sortKey(a)).localeCompare(String(sortKey(b))));
      for (const c of kids) {
        if (seen.has(c)) continue;
        seen.add(c);
        if (include(c)) out.push({ id: c, depth });
        visit(c, depth + 1);
      }
    };
    visit(rootId, 1);
    return out;
  }
}
