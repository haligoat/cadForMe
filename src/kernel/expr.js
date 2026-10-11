// Expression evaluation for parametric values (no eval: a small recursive-descent parser).
// A value can be a number or a string like "width/2 + 3", "2 in", "sin(30)*r".
// Lengths are millimetres, angles are degrees. Part files come from teammates, so this
// must never execute arbitrary code.

const UNITS = Object.assign(Object.create(null), { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, deg: 1, rad: 180 / Math.PI });
const D = Math.PI / 180;
const FUNCS = Object.assign(Object.create(null), {
  sin: (d) => Math.sin(d * D), cos: (d) => Math.cos(d * D), tan: (d) => Math.tan(d * D),
  asin: (x) => Math.asin(x) / D, acos: (x) => Math.acos(x) / D, atan: (x) => Math.atan(x) / D,
  atan2: (y, x) => Math.atan2(y, x) / D,
  sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max, pow: Math.pow,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, log: Math.log, exp: Math.exp,
});
const CONSTS = Object.assign(Object.create(null), { PI: Math.PI, pi: Math.PI });

const TOKEN = /\s*(?:(\d*\.?\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/%^(),]))/y;

function tokenize(src) {
  const toks = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    const start = TOKEN.lastIndex;
    const m = TOKEN.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(start))) break;
      throw new Error(`Unexpected "${src.slice(start).trim()[0]}" in "${src}"`);
    }
    if (m[1] !== undefined) toks.push({ t: "num", v: Number(m[1]) });
    else if (m[2] !== undefined) toks.push({ t: "id", v: m[2] });
    else toks.push({ t: "op", v: m[3] });
  }
  return toks;
}

/** Parse to a closure (vars) => number. */
function compile(src) {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const isOp = (v) => peek()?.t === "op" && peek().v === v;
  const expect = (v) => { if (!isOp(v)) throw new Error(`Expected "${v}" in "${src}"`); i++; };

  function expr() {
    let l = term();
    while (isOp("+") || isOp("-")) { const op = toks[i++].v; const a = l, b = term(); l = op === "+" ? (V) => a(V) + b(V) : (V) => a(V) - b(V); }
    return l;
  }
  function term() {
    let l = unary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = toks[i++].v; const a = l, b = unary();
      l = op === "*" ? (V) => a(V) * b(V) : op === "/" ? (V) => a(V) / b(V) : (V) => a(V) % b(V);
    }
    return l;
  }
  function unary() {
    if (isOp("-")) { i++; const a = unary(); return (V) => -a(V); }
    if (isOp("+")) { i++; return unary(); }
    return power();
  }
  function power() {
    const base = atom();
    if (isOp("^")) { i++; const e = unary(); return (V) => base(V) ** e(V); }
    return base;
  }
  function atom() {
    const tk = toks[i++];
    if (!tk) throw new Error(`Unexpected end of "${src}"`);
    if (tk.t === "num") {
      let n = tk.v;
      if (peek()?.t === "id" && peek().v in UNITS) n *= UNITS[toks[i++].v];
      return () => n;
    }
    if (tk.t === "id") {
      if (isOp("(")) {
        const fn = FUNCS[tk.v];
        if (!fn) throw new Error(`Unknown function "${tk.v}"`);
        i++;
        const args = [];
        if (!isOp(")")) { do { args.push(expr()); } while (isOp(",") && ++i); }
        expect(")");
        return (V) => fn(...args.map((a) => a(V)));
      }
      if (tk.v in CONSTS) { const c = CONSTS[tk.v]; return () => c; }
      const name = tk.v;
      return (V) => V(name);
    }
    if (tk.v === "(") { const e = expr(); expect(")"); return e; }
    throw new Error(`Unexpected "${tk.v}" in "${src}"`);
  }

  if (!toks.length) throw new Error("Empty expression");
  const e = expr();
  if (i < toks.length) throw new Error(`Unexpected "${toks[i].v}" in "${src}"`);
  return e;
}

const cache = new Map();

/** Build an evaluator bound to a part's variables. Variables may reference each other. */
export function makeEvaluator(variables = {}) {
  const values = new Map();
  const resolving = new Set();
  const own = (k) => Object.prototype.hasOwnProperty.call(variables, k);

  const V = (name) => {
    if (values.has(name)) return values.get(name);
    if (!own(name)) throw new Error(`Unknown variable "${name}"`);
    if (resolving.has(name)) throw new Error(`Variable "${name}" references itself`);
    resolving.add(name);
    try { const v = ev(variables[name]); values.set(name, v); return v; } finally { resolving.delete(name); }
  };

  function ev(expr) {
    if (typeof expr === "number") return expr;
    if (typeof expr === "boolean") return expr ? 1 : 0;
    if (expr === undefined || expr === null || expr === "") throw new Error("Missing value");
    const src = String(expr);
    let fn = cache.get(src);
    if (!fn) { fn = compile(src); if (cache.size > 5000) cache.clear(); cache.set(src, fn); }
    const v = fn(V);
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`"${src}" is not a finite number`);
    return v;
  }

  ev.vec = (arr, fallback = [0, 0, 0]) => (Array.isArray(arr) ? arr.map((x) => ev(x)) : fallback);
  ev.opt = (expr, fallback) => (expr === undefined || expr === null || expr === "" ? fallback : ev(expr));
  ev.variables = () => Object.fromEntries(Object.keys(variables).map((k) => {
    try { return [k, V(k)]; } catch (e) { return [k, `error: ${e.message}`]; }
  }));
  return ev;
}
