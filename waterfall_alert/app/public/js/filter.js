// Tag filter expressions, e.g. `Switch & (Home | Cabin) & !Retired`.
//
//   &  and     both sides          |  or  ,   either side
//   !  not     everything but      ( )        grouping
//
// & binds tighter than |. Tag names are matched case-insensitively and may
// contain spaces (`Server room & Camera`); put a name in double quotes if it
// contains one of the symbols above or is one of the words and/or/not.
// A "(" still open at the very end is closed for you, so clicking through
// `Wifi & ( Cabin | Home` works. No imports, so the tests can load it under
// Node.

const WORDS = { and: '&', or: '|', not: '!' };

function tokenize(text) {
  const tokens = [];
  let words = [];
  const flush = () => {
    if (words.length) tokens.push({ name: words.join(' ') });
    words = [];
  };
  const re = /\s*(?:"([^"]*)"?|([&|,!()])|([^\s&|,!()"]+))/gy;
  let m;
  while (re.lastIndex < text.length && (m = re.exec(text))) {
    if (m[1] != null) {
      flush();
      tokens.push({ name: m[1].trim(), quoted: true });
    } else if (m[2]) {
      flush();
      tokens.push({ op: m[2] === ',' ? '|' : m[2] });
    } else if (m[3] && WORDS[m[3].toLowerCase()]) {
      flush();
      tokens.push({ op: WORDS[m[3].toLowerCase()] });
    } else if (m[3]) words.push(m[3]);
    else break; // only whitespace was left
  }
  flush();
  return tokens;
}

// Returns null for an empty expression, { error } if it doesn't parse, or
// { test(tagIds), unclosed } where tagIds are a monitor's tag ids and
// `unclosed` counts the brackets left open at the end.
export function parseTagExpr(text, tags) {
  const tokens = tokenize(String(text ?? ''));
  if (!tokens.length) return null;
  const byName = new Map(tags.map((t) => [t.name.toLowerCase(), t.id]));
  let i = 0;
  let unclosed = 0;
  const peek = () => tokens[i];
  const fail = (msg) => {
    throw new Error(msg);
  };

  const atom = () => {
    const t = tokens[i++];
    if (!t) fail('The filter ends too early');
    if (t.op === '(') {
      if (!peek()) fail('The filter ends too early');
      const node = or();
      const next = peek();
      if (!next) unclosed++;
      else if (next.op === ')') i++;
      else fail(`Expected & or | before "${next.name ?? next.op}"`);
      return node;
    }
    if (t.op === '!') return { not: atom() };
    if (t.op) fail(`Expected a tag name before "${t.op}"`);
    if (!t.name) fail('Empty quotes');
    const id = byName.get(t.name.toLowerCase());
    if (id == null) fail(`No tag called "${t.name}"`);
    return { tag: id };
  };
  const and = () => {
    const args = [atom()];
    while (peek()?.op === '&') {
      i++;
      args.push(atom());
    }
    return args.length > 1 ? { and: args } : args[0];
  };
  const or = () => {
    const args = [and()];
    while (peek()?.op === '|') {
      i++;
      args.push(and());
    }
    return args.length > 1 ? { or: args } : args[0];
  };

  let tree;
  try {
    tree = or();
    if (i < tokens.length) fail(tokens[i].op === ')' ? 'There is a ")" without a "("' : `Expected & or | before "${tokens[i].name ?? tokens[i].op}"`);
  } catch (err) {
    return { error: err.message };
  }
  const evaluate = (node, has) => {
    if (node.tag != null) return has.has(node.tag);
    if (node.not) return !evaluate(node.not, has);
    if (node.and) return node.and.every((n) => evaluate(n, has));
    return node.or.some((n) => evaluate(n, has));
  };
  return { test: (tagIds) => evaluate(tree, new Set(tagIds)), unclosed };
}

// A tag name as it should be written in an expression.
export function exprName(name) {
  const plain = /^[^&|,!()"]+$/.test(name) && !name.split(/\s+/).some((w) => WORDS[w.toLowerCase()]);
  return plain ? name : `"${name}"`;
}
