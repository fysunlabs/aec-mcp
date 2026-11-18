// Experience package parameters.
//
// A fixed experience describes its outcome in terms of a placeholder (`<out>` in
// every published package so far, `{{name}}` going forward). The placeholder is a
// *template*, not a contract: it must be bound to a concrete value at adoption
// time, before anything is written into a task contract. Binding is instantiation,
// not a scope change — there is no user requirement being removed, so it must never
// travel through `task.revise(scope_change=true)`.
//
// This module is deliberately tiny and has no dependencies: it only normalizes,
// finds and substitutes. Whether a binding is *allowed* is decided by the caller.

const TEMPLATE = /\{\{\s*([A-Za-z0-9_.:-]+)\s*\}\}/g;

// `<out>` predates `{{out}}` and every released package still uses it. Both are the
// same parameter, so normalization happens once, at the boundary, and nothing
// downstream ever has to know about the legacy spelling.
export const normalizeTemplate = value =>
  typeof value === 'string' ? value.replaceAll('<out>', '{{out}}') : value;

const walk = (value, fn) => {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map(v => walk(v, fn));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, fn)]));
  }
  return value;
};

// Normalization happens at the leaf, not at the top: an outcome is a nested object,
// so normalizing only the outer value would leave every nested `<out>` untouched.
export function paramNames(value) {
  const found = new Set();
  walk(value, s => {
    for (const m of normalizeTemplate(s).matchAll(TEMPLATE)) found.add(m[1]);
    return s;
  });
  return [...found];
}

// Bind every placeholder. Returns the unresolved names instead of throwing so the
// caller can report all of them at once (a host that forgot two parameters should
// not need two round trips to discover that).
export function bindTemplate(value, bind = {}) {
  const unresolved = new Set();
  const bound = walk(value, s =>
    normalizeTemplate(s).replace(TEMPLATE, (whole, name) => {
      const replacement = bind[name];
      if (replacement === undefined || replacement === null || replacement === '') {
        unresolved.add(name);
        return whole;
      }
      return String(replacement);
    }));
  return { value: bound, unresolved: [...unresolved] };
}

// Merge declared defaults with what the host supplied. An undeclared extra binding
// is kept: a package may grow a parameter before it declares it, and dropping the
// value silently would be worse than carrying it.
export function resolveBind(declared = [], given = {}) {
  const bind = {}, missing = [];
  for (const p of declared) {
    const id = typeof p === 'string' ? p : p.id;
    if (given[id] !== undefined) bind[id] = given[id];
    else if (typeof p === 'object' && p.default !== undefined) bind[id] = p.default;
    else if (typeof p !== 'object' || p.required !== false) missing.push(id);
  }
  for (const [k, v] of Object.entries(given)) bind[k] = v;
  return { bind, missing };
}

// A deliverable path is a path. Annotations, full-width punctuation and whitespace
// belong in `description`; a sentence in `path` becomes an unopenable file and a
// check that can never match.
const PATH_SHAPE = /^[A-Za-z0-9._\-/{}]+$/;
// Normalize first: `<out>.mp4` is a legitimate templated path, while
// `<out>.mp4（由宿主 agent 下载）` is a sentence that will never open.
export const isPathShaped = path => typeof path === 'string' && PATH_SHAPE.test(normalizeTemplate(path));

export { TEMPLATE };
