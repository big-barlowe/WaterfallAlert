// MIB modules -> what each OID is called, its type, units and description.
//
// Not a full ASN.1 compiler: enough of SMIv1/SMIv2 to read the MIB files
// vendors publish, and lenient about the usual mistakes in them. parseMib()
// turns text into modules; a MibLibrary resolves the modules against each
// other (imports) into one index from OID to object; formatValue() uses an
// object's type to show a value (enumerations, display hints, units).
import fs from 'node:fs';
import path from 'node:path';

// ---- tokens -----------------------------------------------------------------

const IDENT = /[A-Za-z0-9_-]/;

function tokenize(text) {
  const toks = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c <= ' ') {
      i++;
    } else if (c === '-' && text[i + 1] === '-') {
      // Comments run to the end of the line. (ASN.1 also ends them at the
      // next "--", but MIBs are full of "---- Heading ----" lines.)
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '"') {
      const j = text.indexOf('"', i + 1);
      const end = j < 0 ? n : j;
      toks.push({ t: 'str', v: text.slice(i + 1, end) });
      i = end + 1;
    } else if (c === "'") {
      // 'ff00'H or '0101'B
      const j = text.indexOf("'", i + 1);
      const end = j < 0 ? n : j;
      const body = text.slice(i + 1, end).replace(/\s/g, '');
      const kind = (text[end + 1] ?? '').toUpperCase();
      const v = kind === 'H' ? parseInt(body || '0', 16) : kind === 'B' ? parseInt(body || '0', 2) : NaN;
      toks.push({ t: 'num', v });
      i = end + 2;
    } else if (c === ':' && text.startsWith('::=', i)) {
      toks.push({ t: 'p', v: '::=' });
      i += 3;
    } else if (c === '.' && text[i + 1] === '.') {
      toks.push({ t: 'p', v: '..' });
      i += 2;
    } else if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(text[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(text[j])) j++;
      toks.push({ t: 'num', v: Number(text.slice(i, j)) });
      i = j;
    } else if (/[A-Za-z]/.test(c)) {
      let j = i + 1;
      // a hyphen belongs to the name unless it starts a comment
      while (j < n && IDENT.test(text[j]) && !(text[j] === '-' && text[j + 1] === '-')) j++;
      while (text[j - 1] === '-') j--;
      toks.push({ t: 'id', v: text.slice(i, j) });
      i = j;
    } else {
      toks.push({ t: 'p', v: c });
      i++;
    }
  }
  return toks;
}

// ---- parsing ----------------------------------------------------------------

// Types the SMI defines; a SYNTAX naming one of these needs no lookup.
const APP_TYPES = new Set(['Counter32', 'Counter64', 'Gauge32', 'Integer32', 'Unsigned32', 'TimeTicks', 'IpAddress', 'Opaque',
  'Counter', 'Gauge', 'NetworkAddress']);

class Parser {
  constructor(toks) {
    this.toks = toks;
    this.i = 0;
  }

  peek(k = 0) { return this.toks[this.i + k]; }
  next() { return this.toks[this.i++]; }
  is(v, k = 0) { return this.toks[this.i + k]?.v === v; }
  eat(v) {
    if (this.is(v)) return this.next();
    return null;
  }

  // Skips a balanced { } or ( ) group starting at the current token.
  skipGroup() {
    const open = this.peek()?.v;
    const close = { '{': '}', '(': ')', '[': ']' }[open];
    if (!close) return;
    let depth = 0;
    while (this.peek()) {
      const v = this.next().v;
      if (v === open) depth++;
      else if (v === close && --depth === 0) return;
    }
  }

  // name(number), ... inside braces: enumerations and BITS.
  namedNumbers() {
    const out = {};
    this.next(); // {
    while (this.peek() && !this.is('}')) {
      const t = this.next();
      if (t.t === 'id' && this.is('(')) {
        this.next();
        const num = this.next();
        if (num?.t === 'num') out[num.v] = t.v;
        while (this.peek() && !this.is(')')) this.next();
        this.next();
      }
    }
    this.next(); // }
    return out;
  }

  // SYNTAX: a type, with enough structure to know where it ends.
  type() {
    if (this.is('[')) {
      this.skipGroup();
      this.eat('IMPLICIT') || this.eat('EXPLICIT');
    }
    const t = this.next();
    if (!t) return { base: 'unknown' };
    let out;
    switch (t.v) {
      case 'TEXTUAL-CONVENTION': {
        const c = this.clauses(['SYNTAX']);
        return { tc: true, hint: c.hint, desc: c.desc, status: c.status, syntax: c.syntax ?? { base: 'unknown' } };
      }
      case 'INTEGER':
        out = { base: 'INTEGER' };
        if (this.is('{')) out.enums = this.namedNumbers();
        break;
      case 'OCTET':
        this.eat('STRING');
        out = { base: 'OCTET STRING' };
        break;
      case 'BIT':
        this.eat('STRING');
        out = { base: 'OCTET STRING' };
        if (this.is('{')) out.bits = this.namedNumbers();
        break;
      case 'OBJECT':
        this.eat('IDENTIFIER');
        out = { base: 'OBJECT IDENTIFIER' };
        break;
      case 'BITS':
        out = { base: 'BITS', bits: this.is('{') ? this.namedNumbers() : {} };
        break;
      case 'SEQUENCE':
        if (this.eat('OF')) {
          const of = this.type();
          return { base: 'SEQUENCE OF', of: of.ref };
        }
        this.skipGroup();
        return { base: 'SEQUENCE' };
      case 'CHOICE':
        this.skipGroup();
        return { base: 'CHOICE' };
      default: {
        if (t.t !== 'id') return { base: 'unknown' };
        let ref = t.v;
        if (this.is('.') && this.peek(1)?.t === 'id') { // Module.Type
          this.next();
          ref = this.next().v;
        }
        out = APP_TYPES.has(ref) ? { base: ref } : { ref };
        if (this.is('{')) out.enums = this.namedNumbers();
      }
    }
    if (this.is('(')) this.skipGroup(); // size or range
    return out;
  }

  // The clauses of a macro (OBJECT-TYPE, TEXTUAL-CONVENTION, ...) up to "::="
  // or, for a textual convention, up to the end of its SYNTAX.
  clauses(stopAfter = []) {
    const c = {};
    while (this.peek() && !this.is('::=') && !this.is('END')) {
      const t = this.next();
      switch (t.v) {
        case 'SYNTAX': {
          const type = this.type();
          c.syntax ??= type;
          if (stopAfter.includes('SYNTAX')) return c;
          break;
        }
        case 'WRITE-SYNTAX': this.type(); break;
        case 'UNITS': c.units = this.str(); break;
        case 'DESCRIPTION': c.desc ??= this.str(); break;
        case 'DISPLAY-HINT': c.hint = this.str(); break;
        case 'REFERENCE': this.str(); break;
        case 'MAX-ACCESS': case 'ACCESS': case 'MIN-ACCESS':
          if (t.v !== 'MIN-ACCESS') c.access ??= this.peek()?.t === 'id' ? this.next().v : undefined;
          break;
        case 'STATUS': c.status ??= this.peek()?.t === 'id' ? this.next().v : undefined; break;
        case 'INDEX': case 'AUGMENTS':
          if (this.is('{')) {
            const list = [];
            this.next();
            while (this.peek() && !this.is('}')) {
              const x = this.next();
              if (x.t === 'id' && x.v !== 'IMPLIED') list.push(x.v);
            }
            this.next();
            c[t.v === 'INDEX' ? 'index' : 'augments'] = list;
          }
          break;
        default:
          if (t.v === '{' || t.v === '(') {
            this.i--;
            this.skipGroup();
          }
      }
    }
    return c;
  }

  str() {
    return this.peek()?.t === 'str' ? this.next().v : undefined;
  }

  // { parent 3 } / { iso org(3) dod(6) 1 } -> [{ name?, num? }]
  oidValue() {
    if (!this.eat('{')) return null;
    const parts = [];
    while (this.peek() && !this.is('}')) {
      const t = this.next();
      if (t.t === 'num') parts.push({ num: t.v });
      else if (t.t === 'id') {
        if (this.is('.') && this.peek(1)?.t === 'id') { // Module.name
          this.next();
          parts.push({ name: this.next().v });
        } else if (this.is('(')) {
          this.next();
          const num = this.next();
          parts.push({ name: t.v, num: num?.t === 'num' ? num.v : undefined });
          while (this.peek() && !this.is(')')) this.next();
          this.next();
        } else parts.push({ name: t.v });
      }
    }
    this.next();
    return parts;
  }

  module() {
    // NAME DEFINITIONS [tag defaults] ::= BEGIN
    const name = this.next().v;
    while (this.peek() && !this.is('BEGIN')) this.next();
    this.next();
    const mod = { name, imports: new Map(), defs: new Map(), types: new Map(), errors: [] };
    while (this.peek() && !this.is('END')) {
      const t = this.peek();
      if (t.v === 'IMPORTS') {
        this.next();
        let pending = [];
        while (this.peek() && !this.is(';')) {
          const x = this.next();
          if (x.v === 'FROM') {
            const from = this.next()?.v;
            for (const s of pending) mod.imports.set(s, from);
            pending = [];
            // some modules put an OID value after the module name
            if (this.is('{')) this.skipGroup();
          } else if (x.t === 'id') pending.push(x.v);
        }
        this.next();
        continue;
      }
      if (t.v === 'EXPORTS') {
        while (this.peek() && !this.is(';')) this.next();
        this.next();
        continue;
      }
      if (t.t !== 'id') {
        this.next();
        continue;
      }
      try {
        this.assignment(mod);
      } catch (err) {
        mod.errors.push(`${t.v}: ${err.message}`);
      }
    }
    this.next(); // END
    return mod;
  }

  assignment(mod) {
    const name = this.next().v;
    if (this.is('MACRO')) { // the SMI's own macro definitions
      while (this.peek() && !this.is('END')) this.next();
      this.next();
      return;
    }
    if (this.is('::=')) { // Type ::= ...
      this.next();
      mod.types.set(name, this.type());
      return;
    }
    if (this.is('OBJECT') && this.is('IDENTIFIER', 1) && this.is('::=', 2)) {
      this.i += 3;
      const oid = this.oidValue();
      if (oid) mod.defs.set(name, { kind: 'node', oid });
      return;
    }
    const macro = this.next();
    if (macro?.t !== 'id') return;
    const c = this.clauses();
    if (!this.eat('::=')) return;
    if (!this.is('{')) { // TRAP-TYPE ::= 3, or a plain value
      this.next();
      return;
    }
    const oid = this.oidValue();
    if (!oid) return;
    const kind = { 'OBJECT-TYPE': 'object', 'MODULE-IDENTITY': 'module', 'OBJECT-IDENTITY': 'node', 'NOTIFICATION-TYPE': 'notification' }[macro.v] ?? 'other';
    mod.defs.set(name, { kind, oid, ...c, macro: macro.v });
  }
}

// Every module in a MIB file. Throws when there is none.
export function parseMib(text) {
  const p = new Parser(tokenize(String(text)));
  const modules = [];
  while (p.peek()) {
    if (p.peek().t === 'id' && p.is('DEFINITIONS', 1)) modules.push(p.module());
    else p.next();
  }
  if (!modules.length) throw new Error('No MIB module found (expected "NAME DEFINITIONS ::= BEGIN")');
  return modules;
}

// The text of each module in a file, by name: what gets stored when a file
// holds several.
export function splitModules(text) {
  const out = new Map();
  const re = /^[ \t]*([A-Za-z][A-Za-z0-9-]*)\s+DEFINITIONS\b/gm;
  const starts = [...String(text).matchAll(re)];
  starts.forEach((m, i) => out.set(m[1], text.slice(m.index, starts[i + 1]?.index ?? text.length).trim() + '\n'));
  return out;
}

// ---- resolving ----------------------------------------------------------------

// Where everything starts, for modules that use these without importing them
// (or import them from a module nobody has).
const ROOTS = {
  ccitt: '0', iso: '1', 'joint-iso-ccitt': '2', org: '1.3', dod: '1.3.6', internet: '1.3.6.1', directory: '1.3.6.1.1',
  mgmt: '1.3.6.1.2', 'mib-2': '1.3.6.1.2.1', transmission: '1.3.6.1.2.1.10', experimental: '1.3.6.1.3', private: '1.3.6.1.4',
  enterprises: '1.3.6.1.4.1', security: '1.3.6.1.5', snmpV2: '1.3.6.1.6', snmpDomains: '1.3.6.1.6.1', snmpProxys: '1.3.6.1.6.2',
  snmpModules: '1.3.6.1.6.3', zeroDotZero: '0.0',
};

// Modules that only define the SMI itself: nothing to look up in them.
const SMI_MODULES = new Set(['SNMPv2-SMI', 'SNMPv2-TC', 'SNMPv2-CONF', 'RFC1155-SMI', 'RFC-1212', 'RFC-1215', 'RFC1065-SMI']);

const tidy = (s) => (s == null ? undefined : String(s).split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n'));

export class MibLibrary {
  constructor() {
    this.modules = new Map(); // name -> { mod, source, rank }
  }

  // source: 'bundled' | 'uploaded'. A later module of the same name replaces
  // the earlier one (an upload replaces the bundled copy).
  add(mod, source = 'uploaded', meta = {}) {
    this.modules.set(mod.name, { mod, source, rank: source === 'uploaded' ? 2 : RFC1213.has(mod.name) ? 0 : 1, ...meta });
  }

  remove(name) {
    this.modules.delete(name);
  }

  #symbol(mod, name, seen) {
    if (mod.defs.has(name)) return [mod, mod.defs.get(name)];
    const from = mod.imports.get(name);
    const src = from && this.modules.get(from)?.mod;
    if (src && src !== mod && !seen.has(`${src.name}:${name}`)) {
      seen.add(`${src.name}:${name}`);
      const hit = this.#symbol(src, name, seen);
      if (hit) return hit;
    }
    return null;
  }

  // OID of `name` as seen from `mod`, as a dotted string; null if unknown.
  #oid(mod, name, seen = new Set()) {
    const key = `${mod.name}:${name}`;
    if (this.oids.has(key)) return this.oids.get(key);
    if (seen.has(key)) return null;
    seen.add(key);
    let out = null;
    const hit = this.#symbol(mod, name, new Set());
    if (hit) {
      const [owner, def] = hit;
      const [first, ...rest] = def.oid;
      const base = !first ? null : first.num != null ? String(first.num) : this.#oid(owner, first.name, seen);
      if (base != null && rest.every((p) => p.num != null)) out = [base, ...rest.map((p) => p.num)].join('.');
    } else if (ROOTS[name]) {
      out = ROOTS[name];
    } else {
      // imported from a module we don't have, or not imported at all: any
      // loaded module that defines it
      const other = this.#definers.get(name);
      if (other && other !== mod) out = this.#oid(other, name, seen);
    }
    this.oids.set(key, out);
    return out;
  }

  #typeDef(mod, name, seen) {
    if (mod.types.has(name)) return [mod, mod.types.get(name)];
    const from = mod.imports.get(name);
    const src = from && this.modules.get(from)?.mod;
    if (src && src !== mod && !seen.has(src.name)) {
      seen.add(src.name);
      const hit = this.#typeDef(src, name, seen);
      if (hit) return hit;
    }
    const other = this.#typeOwners.get(name);
    return other && other !== mod && !seen.has(other.name) ? [other, other.types.get(name)] : null;
  }

  // A SYNTAX down to its base type, keeping the outermost textual
  // convention's name and display hint and the innermost enumerations.
  #resolveType(mod, type, depth = 0) {
    if (!type || depth > 12) return { base: 'unknown' };
    if (type.tc) return this.#resolveType(mod, type.syntax, depth + 1);
    if (type.ref) {
      const hit = this.#typeDef(mod, type.ref, new Set([mod.name]));
      if (!hit) return { base: 'unknown', tc: type.ref, enums: type.enums };
      const [owner, def] = hit;
      const inner = this.#resolveType(owner, def, depth + 1);
      return { ...inner, tc: type.ref, hint: (def.tc ? def.hint : undefined) ?? inner.hint, enums: type.enums ?? inner.enums };
    }
    return { ...type };
  }

  // Builds the index. Returns this.
  compile() {
    this.oids = new Map();
    this.#definers = new Map();
    this.#typeOwners = new Map();
    const ordered = [...this.modules.values()].sort((a, b) => b.rank - a.rank);
    for (const { mod } of ordered) {
      for (const name of mod.defs.keys()) if (!this.#definers.has(name)) this.#definers.set(name, mod);
      for (const name of mod.types.keys()) if (!this.#typeOwners.has(name)) this.#typeOwners.set(name, mod);
    }
    this.index = new Map();
    this.stats = new Map();
    for (const { mod, rank } of ordered) {
      let objects = 0;
      let unresolved = 0;
      for (const [name, def] of mod.defs) {
        const oid = this.#oid(mod, name);
        if (!oid) {
          unresolved++;
          continue;
        }
        objects++;
        const had = this.index.get(oid);
        // higher rank first, then current over deprecated/obsolete
        if (had && (had.rank > rank || (had.rank === rank && !(had.status !== 'current' && def.status === 'current')))) continue;
        const entry = { name, module: mod.name, kind: def.kind, rank, status: def.status };
        if (def.kind === 'object' && def.syntax) {
          const s = this.#resolveType(mod, def.syntax);
          if (s.base === 'SEQUENCE OF') entry.kind = 'table';
          else if (s.base === 'SEQUENCE') entry.kind = 'row';
          else entry.syntax = s;
          if (def.units) entry.units = def.units;
          if (def.access) entry.access = def.access;
          if (def.index) entry.index = def.index;
        }
        if (def.desc) entry.desc = tidy(def.desc);
        this.index.set(oid, entry);
        // named arcs along the way ({ iso org(3) dod(6) }) name those nodes
        let prefix = null;
        for (const p of def.oid) {
          prefix = prefix == null ? (p.num != null ? String(p.num) : this.#oid(mod, p.name)) : `${prefix}.${p.num}`;
          if (prefix == null) break;
          if (p.name && p.num != null && !this.index.has(prefix)) this.index.set(prefix, { name: p.name, module: mod.name, kind: 'node', rank: -1 });
        }
      }
      const missing = [...new Set(mod.imports.values())].filter((m) => !this.modules.has(m) && !SMI_MODULES.has(m)).sort();
      this.stats.set(mod.name, { objects, unresolved, missing, errors: mod.errors });
    }
    return this;
  }

  #definers = new Map();
  #typeOwners = new Map();

  // The object an OID belongs to: { oid, entry, suffix } for the longest
  // known prefix, or null. `suffix` is the rest (an instance index, ".0").
  lookup(oid) {
    if (!this.index) this.compile();
    const arcs = String(oid).split('.');
    for (let n = arcs.length; n > 0; n--) {
      const prefix = arcs.slice(0, n).join('.');
      const entry = this.index.get(prefix);
      if (entry) return { oid: prefix, entry, suffix: n === arcs.length ? '' : `.${arcs.slice(n).join('.')}` };
    }
    return null;
  }

  // What to call an OID: the object it is an instance of ("ifDescr.3"), or
  // for anything else only an exact match. A vendor OID under nothing but
  // "enterprises" has no name.
  label(oid) {
    let hit = this.lookup(oid);
    if (!hit) return null;
    if (!hit.entry.syntax) {
      // an alias node for an instance (sysUpTimeInstance = sysUpTime.0):
      // the object wins
      const arcs = hit.oid.split('.');
      for (let n = arcs.length - 1; n > 0; n--) {
        const above = this.index.get(arcs.slice(0, n).join('.'));
        if (above?.syntax) {
          hit = { oid: arcs.slice(0, n).join('.'), entry: above, suffix: String(oid).slice(arcs.slice(0, n).join('.').length) };
          break;
        }
      }
    }
    const { entry, suffix } = hit;
    if (suffix && !entry.syntax) return null;
    return { ...hit, name: `${entry.name}${suffix}` };
  }

  // The deepest named node above an OID nothing describes, and the arc
  // below it: where to look for the MIB. { oid, name } or null.
  near(oid) {
    const hit = this.lookup(oid);
    if (!hit || !hit.suffix) return null;
    const next = hit.suffix.split('.')[1];
    return { oid: `${hit.oid}.${next}`, under: hit.entry.name };
  }

  // Modules and how they resolved, for the MIB library page.
  list() {
    if (!this.index) this.compile();
    return [...this.modules.values()].map(({ mod, source, filename, addedAt }) => {
      const s = this.stats.get(mod.name) ?? { objects: 0, unresolved: 0, missing: [], errors: [] };
      return { name: mod.name, source, filename, addedAt, objects: s.objects, unresolved: s.unresolved, missing: s.missing, errors: s.errors.slice(0, 5) };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
}

const RFC1213 = new Set(['RFC1213-MIB', 'RFC1158-MIB', 'RFC1155-SMI']); // superseded: lowest rank

// ---- the bundled modules and the current library ----------------------------

const BUNDLED_DIR = new URL('../mibs/', import.meta.url);
let bundledCache = null;

// The standard MIBs shipped with the add-on (app/mibs), parsed once.
export function bundledModules() {
  if (bundledCache) return bundledCache;
  bundledCache = [];
  let files = [];
  try {
    files = fs.readdirSync(BUNDLED_DIR).filter((f) => !f.startsWith('.') && !/\.md$/i.test(f)).sort();
  } catch {
    // no bundled MIBs
  }
  for (const f of files) {
    try {
      for (const mod of parseMib(fs.readFileSync(path.join(BUNDLED_DIR.pathname, f), 'utf8'))) bundledCache.push(mod);
    } catch {
      // skip a broken file
    }
  }
  return bundledCache;
}

// uploaded: [{ name, filename, text, addedAt }] from the store.
export function buildLibrary(uploaded = []) {
  const lib = new MibLibrary();
  for (const mod of bundledModules()) lib.add(mod, 'bundled');
  for (const u of uploaded) {
    try {
      for (const mod of parseMib(u.text)) lib.add(mod, 'uploaded', { filename: u.filename, addedAt: u.addedAt });
    } catch {
      // stored text that no longer parses: skip
    }
  }
  return lib.compile();
}

let current = null;
export function mibLibrary() {
  current ??= buildLibrary();
  return current;
}
export function setMibLibrary(lib) {
  current = lib;
}

// ---- values -------------------------------------------------------------------

const MISSING_TYPES = new Set(['noSuchObject', 'noSuchInstance', 'endOfMibView', 'null']);

export function duration(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : m ? `${m}m ${Math.floor(s % 60)}s` : `${(Math.round(s * 100) / 100)}s`;
}

// Octet strings: text when they read as text, otherwise hex.
export function octetText(buf, sep = ' ') {
  if (!Buffer.isBuffer(buf)) return buf == null ? '' : String(buf);
  const s = buf.toString('utf8');
  // eslint-disable-next-line no-control-regex
  if (!/[\x00-\x08\x0e-\x1f\x7f�]/.test(s.replace(/\0+$/, ''))) return s.replace(/\0+$/, '');
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(sep);
}

// RFC 2579 DISPLAY-HINT for octet strings, e.g. "1x:" (MAC), "255a" (text),
// "1d.1d.1d.1d" (IPv4), "2d-1d-1d,1d:1d:1d.1d,1a1d:1d" (date and time).
export function octetHint(hint, buf) {
  const specs = [];
  let i = 0;
  while (i < hint.length) {
    const star = hint[i] === '*';
    if (star) i++;
    let len = '';
    while (/[0-9]/.test(hint[i] ?? '')) len += hint[i++];
    const fmt = hint[i++];
    if (!len || !'xdoat'.includes(fmt ?? '-')) throw new Error(`Bad display hint "${hint}"`);
    let sep = null;
    let term = null;
    if (i < hint.length && !/[0-9*]/.test(hint[i])) sep = hint[i++];
    if (star && i < hint.length && !/[0-9*]/.test(hint[i])) term = hint[i++];
    specs.push({ star, len: Number(len), fmt, sep, term });
  }
  let out = '';
  let pos = 0;
  let k = 0;
  while (pos < buf.length) {
    const s = specs[Math.min(k++, specs.length - 1)];
    const reps = s.star ? buf[pos++] : 1;
    for (let r = 0; r < reps && pos < buf.length; r++) {
      const chunk = buf.subarray(pos, pos + s.len);
      pos += chunk.length;
      if (s.fmt === 'a' || s.fmt === 't') out += chunk.toString(s.fmt === 't' ? 'utf8' : 'latin1');
      else {
        const n = chunk.reduce((a, b) => a * 256n + BigInt(b), 0n);
        out += s.fmt === 'x' ? n.toString(16).padStart(chunk.length * 2, '0') : n.toString(s.fmt === 'o' ? 8 : 10);
      }
      if (s.sep && pos < buf.length && !(s.term && r === reps - 1)) out += s.sep;
    }
    if (s.term && pos < buf.length) out += s.term;
  }
  return out;
}

function dateAndTime(buf) {
  if (buf.length !== 8 && buf.length !== 11) return null;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const y = buf.readUInt16BE(0);
  let s = `${y}-${p(buf[2])}-${p(buf[3])} ${p(buf[4])}:${p(buf[5])}:${p(buf[6])}`;
  if (buf.length === 11) s += ` ${String.fromCharCode(buf[8])}${p(buf[9])}:${p(buf[10])}`;
  return s;
}

function intHint(hint, n) {
  const m = /^([dxob])(?:-(\d+))?$/.exec(hint ?? '');
  if (!m) return null;
  if (m[1] === 'd') return m[2] ? (n / 10 ** Number(m[2])).toFixed(Number(m[2])) : String(n);
  return n.toString({ x: 16, o: 8, b: 2 }[m[1]]);
}

const withUnits = (text, units) => {
  if (!units) return text;
  if (/^(percent|%)$/i.test(units)) return `${text}%`;
  return `${text} ${units}`;
};

// What a value is, as text: { text, raw? } where raw is the number behind an
// enumeration or hint. `info` is an index entry (or null); vb = { type,
// value } as the SNMP client decodes it (octet strings as Buffers).
export function formatValue(info, vb, lib = mibLibrary()) {
  const { type, value } = vb;
  if (value == null || MISSING_TYPES.has(type)) return { text: type };
  const s = info?.syntax;
  if (typeof value === 'number') {
    if (type === 'timeticks') return { text: duration(value / 100), raw: String(value) };
    if (s?.enums?.[value] != null) return { text: s.enums[value], raw: String(value) };
    const hinted = s?.hint ? intHint(s.hint, value) : null;
    if (hinted != null) return { text: withUnits(hinted, info.units), raw: String(value) };
    return { text: withUnits(String(value), info?.units) };
  }
  if (Buffer.isBuffer(value)) {
    if (s?.bits) {
      const set = [];
      value.forEach((byte, i) => {
        for (let b = 0; b < 8; b++) if (byte & (0x80 >> b)) set.push(s.bits[i * 8 + b] ?? `bit ${i * 8 + b}`);
      });
      return { text: set.length ? set.join(', ') : '(none)', raw: octetText(value) };
    }
    if (s?.tc === 'DateAndTime') {
      const dt = dateAndTime(value);
      if (dt) return { text: dt };
    }
    if (s?.hint) {
      try {
        return { text: withUnits(octetHint(s.hint, value), info.units) };
      } catch {
        // fall through to the guess
      }
    }
    return { text: withUnits(octetText(value), info?.units) };
  }
  if (type === 'oid') {
    const name = lib.label(value)?.name;
    return name ? { text: name, raw: value } : { text: value };
  }
  return { text: withUnits(String(value), info?.units) };
}
