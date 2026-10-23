/* Проверка ответов: числа, наборы чисел, формулы (сравнение со случайными значениями), regexp. */
(function (PL) {
'use strict';
const nums = t => (t.replace(/[−–—]/g, '-').replace(/,/g, '.').replace(/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/g, (m, x, y) => String(x / y)).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
const FN = {sqrt:'Math.sqrt',sin:'Math.sin',cos:'Math.cos',tan:'Math.tan',tg:'Math.tan',acos:'Math.acos',arccos:'Math.acos',atan:'Math.atan',arctg:'Math.atan',arctan:'Math.atan',asin:'Math.asin',arcsin:'Math.asin',ln:'Math.log',pi:'Math.PI'};
function toJs(src, names) {
  let s = src.replace(/[₀-₉]/g, c => c.charCodeAt(0) - 8320).replace(/²/g, '^2').replace(/³/g, '^3')
    .replace(/Δt|dt/g, 'Dt').replace(/Δ/g, 'D').replace(/[−–—]/g, '-').replace(/[×·⋅]/g, '*').replace(/\^/g, '**')
    .replace(/√\s*([A-Za-z0-9.]+)/g, 'sqrt($1)').replace(/√/g, 'sqrt')
    .replace(/π/g, 'pi').replace(/μ/g, 'mu').replace(/α/g, 'alpha').replace(/ρ/g, 'rho').replace(/\s+/g, '');
  for (let m; (m = /(sin|cos|tan|tg)\*\*(\d)/.exec(s));) {
    const i = m.index + m[0].length; let j = i;
    if (s[i] === '(') { let d = 0; do { d += s[j] === '(' ? 1 : s[j] === ')' ? -1 : 0; j++; } while (j < s.length && d > 0); }
    else { const o = /^[A-Za-z]+\d*/.exec(s.slice(i)); j = i + (o ? o[0].length : 0); }
    s = s.slice(0, m.index) + '(' + m[1] + '(' + s.slice(i, j) + '))**' + m[2] + s.slice(j);
  }
  const t = s.match(/\d+\.?\d*|[A-Za-z]+\d*|\*\*|[-+*/()]/g);
  if (!t || t.join('') !== s) return null;
  const known = [...names, ...Object.keys(FN)].sort((a, b) => b.length - a.length);
  const items = [];
  for (const tok of t) {
    if (/^[A-Za-z]/.test(tok) && !known.includes(tok)) {
      let rest = tok;
      while (rest) { const k = known.find(n => rest.startsWith(n)) || rest[0]; items.push(k); rest = rest.slice(k.length); }
    } else items.push(tok);
  }
  const isFn = x => FN[x] && x !== 'pi';
  const isEnd = x => /^[\d)]/.test(x) || x === 'pi' || (/^[A-Za-z]/.test(x) && !isFn(x));
  const isStart = x => /^[\d(A-Za-z]/.test(x);
  let js = '';
  items.forEach((x, k) => {
    if (k && isEnd(items[k - 1]) && isStart(x)) js += '*';
    js += isFn(x) || x === 'pi' ? FN[x] : /^[A-Za-z]/.test(x) ? (names.includes(x) ? 'v.' + x : '1.7') : x;
  });
  try { return new Function('v', 'return ' + js); } catch (e) { return null; }
}
function exprOk(inp, sp) {
  const names = sp.v.split(' ');
  const ref = toJs(sp.e, names), usr = toJs(inp, names);
  if (!ref || !usr) return false;
  let k = 0, ratio = null;
  for (let t = 0; k < 6 && t < 1500; t++) {
    const v = {};
    names.forEach(x => v[x] = x === 'alpha' ? .3 + Math.random() * .8 : .6 + Math.random() * 2.4);
    if (sp.c && !sp.c(v)) continue;
    let a, b;
    try { a = ref(v); b = usr(v); } catch (e) { return false; }
    if (!isFinite(a)) continue;
    if (!isFinite(b)) return false;
    k++;
    if (sp.p) { const q = b / a; if (Math.abs(q) < 1e-9) return false; if (ratio === null) ratio = q; else if (Math.abs(q - ratio) > 1e-6 * Math.abs(ratio)) return false; }
    else if (Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(a))) return false;
  }
  return k > 0;
}
function isRight(v, a) {
  v = v.trim();
  if (a instanceof RegExp) return a.test(v) || a.test(v.replace(/\s/g, ''));
  if (a && a.e) return [v, ...v.split(/[;,\n]/)].some(p => { p = p.replace(/^.*[=~∝]/, ''); return p.trim() !== '' && exprOk(p, a); });
  const n = nums(Array.isArray(a) ? v.replace(/,/g, ' ') : v);
  if (Array.isArray(a)) {
    const u = [...new Set(n)].sort((x, y) => x - y);
    return u.length === a.length && u.every((x, i) => Math.abs(x - a[i]) < 1e-6);
  }
  return n.length > 0 && Math.abs(n[0] - a) < 1e-6;
}

PL.checker = { isRight, maxScore: a => a.filter(x => x !== null).length };
})(window.PL = window.PL || {});
