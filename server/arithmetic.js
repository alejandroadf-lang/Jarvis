// Arithmetic the model does not do in its head.
//
// The Business Case Analyst sizes markets and computes unit economics on the
// cheapest model in the company, and the measured failure mode for small models
// is specific: they follow the right reasoning steps and then get the sums
// wrong, with logical error rates climbing as the numbers get messier. That is
// arithmetic-in-weights, not broken reasoning — so the fix is a calculator, not
// a more expensive model. Promoting the agent would cost ~15x and buy the ~5%
// of research quality that model choice explains; this costs nothing and buys
// the part that was actually wrong.
//
// A recursive-descent parser rather than eval(), because the expression comes
// from a model and eval() on model output is a remote code execution hole with
// extra steps. Nothing here can reach the filesystem, the network or a global:
// the only things this grammar knows how to do are the four operations, powers,
// parentheses and percentages.

const OPERATORS = '+-*/^%';

/**
 * Evaluates one arithmetic expression.
 *
 * @returns {{ok: true, value: number}|{ok: false, error: string}}
 */
export function evaluate(expression) {
  const text = String(expression ?? '').trim();
  if (!text) return { ok: false, error: 'An expression is required.' };
  if (text.length > 500) return { ok: false, error: 'Expression is too long — split the calculation into steps.' };

  let tokens;
  try {
    tokens = tokenize(text);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!tokens.length) return { ok: false, error: 'An expression is required.' };

  const state = { tokens, at: 0 };
  let value;
  try {
    value = parseExpression(state);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (state.at < state.tokens.length) {
    return { ok: false, error: `Unexpected "${state.tokens[state.at].value}" — check the brackets and operators.` };
  }
  if (!Number.isFinite(value)) {
    return { ok: false, error: 'That does not come out to a finite number — check for a division by zero.' };
  }
  return { ok: true, value };
}

// Separators people and models both write in big numbers. "1_000_000" and
// "1,000,000" are the same million, and refusing either would make the tool
// annoying enough to route around — which is how it ends up unused and the
// arithmetic goes back into the weights.
function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === ' ' || char === '\t' || char === '\n' || char === ',' || char === '_') {
      i += 1;
      continue;
    }
    if (char === '(' || char === ')') {
      tokens.push({ type: char, value: char });
      i += 1;
      continue;
    }
    if (OPERATORS.includes(char)) {
      tokens.push({ type: 'op', value: char });
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      let j = i;
      while (j < text.length && /[0-9._,]/.test(text[j])) j += 1;
      const raw = text.slice(i, j).replace(/[_,]/g, '');
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`"${raw}" is not a number.`);
      tokens.push({ type: 'number', value });
      i = j;
      continue;
    }
    throw new Error(`"${char}" is not something this calculator understands — it does + - * / ^ %, brackets and numbers.`);
  }
  return tokens;
}

function peek(state) {
  return state.tokens[state.at];
}

function parseExpression(state) {
  let left = parseTerm(state);
  while (peek(state)?.type === 'op' && (peek(state).value === '+' || peek(state).value === '-')) {
    const op = state.tokens[state.at++].value;
    const right = parseTerm(state);
    left = op === '+' ? left + right : left - right;
  }
  return left;
}

function parseTerm(state) {
  let left = parseUnary(state);
  while (peek(state)?.type === 'op' && (peek(state).value === '*' || peek(state).value === '/')) {
    const op = state.tokens[state.at++].value;
    const right = parseUnary(state);
    if (op === '*') left *= right;
    else {
      if (right === 0) throw new Error('Division by zero.');
      left /= right;
    }
  }
  return left;
}

function parseUnary(state) {
  const token = peek(state);
  if (token?.type === 'op' && (token.value === '-' || token.value === '+')) {
    state.at += 1;
    const value = parseUnary(state);
    return token.value === '-' ? -value : value;
  }
  return parsePower(state);
}

function parsePower(state) {
  const base = parsePostfix(state);
  if (peek(state)?.type === 'op' && peek(state).value === '^') {
    state.at += 1;
    const exponent = parseUnary(state); // right-associative
    return base ** exponent;
  }
  return base;
}

// "%" is postfix, not infix: a business case writes "500 * 20%", never
// "500 % 20". Reading it as an operator between two numbers made the most
// natural way to write a conversion rate a syntax error, which is how a
// calculator ends up unused.
function parsePostfix(state) {
  let value = parseAtom(state);
  while (peek(state)?.type === 'op' && peek(state).value === '%') {
    state.at += 1;
    value /= 100;
  }
  return value;
}

function parseAtom(state) {
  const token = peek(state);
  if (!token) throw new Error('The expression ends early — something is missing after the last operator.');
  if (token.type === 'number') {
    state.at += 1;
    return token.value;
  }
  if (token.type === '(') {
    state.at += 1;
    const value = parseExpression(state);
    if (peek(state)?.type !== ')') throw new Error('A bracket is opened and never closed.');
    state.at += 1;
    return value;
  }
  throw new Error(`Expected a number but found "${token.value}".`);
}

/** Numbers a founder reads, not floating-point exhaust. */
export function formatNumber(value) {
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  const rounded = Math.round(value * 100) / 100;
  return rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
