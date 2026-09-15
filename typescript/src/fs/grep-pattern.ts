/**
 * Translate a grep pattern into the regex dialect the search endpoint speaks.
 *
 * The dialect being matched is the one the sandbox's own grep implements,
 * which compiles a Basic Regular Expression into RE2 syntax with a small state
 * machine. Every rule here mirrors that machine rather than POSIX, so a served
 * search selects the same lines the built-in would have.
 *
 * Anything that cannot be expressed returns `null`, and the caller falls back
 * to the built-in rather than approximating.
 */

/** Characters that are literal in a BRE but syntax in Rust's regex. */
const LITERAL_UNESCAPED = new Set(['+', '?', '(', ')', '{', '}', '|']);

/**
 * Escapes that mean a literal character here and a word boundary in Rust's
 * regex. Left alone they would silently match somewhere else.
 */
const LITERAL_WHEN_ESCAPED = new Set(['<', '>']);

/**
 * Copy a bracket expression, or return `null` if it never closes.
 *
 * `[...]` means the same thing in both dialects, including POSIX classes like
 * `[:alpha:]`. Two spellings need attention: a leading `!` negates like `^`,
 * and a leading `]` is a literal member rather than the close.
 */
function readBracket(pattern: string, start: number): { text: string; next: number } | null {
  let index = start + 1;
  let text = '[';
  if (pattern[index] === '^' || pattern[index] === '!') {
    text += '^';
    index += 1;
  }
  if (pattern[index] === ']') {
    text += '\\]';
    index += 1;
  }
  while (index < pattern.length) {
    const char = pattern[index] as string;
    if (char === ']') {
      return { text: `${text}]`, next: index + 1 };
    }
    if (char === '[' && pattern[index + 1] === ':') {
      const close = pattern.indexOf(':]', index);
      if (close === -1) return null;
      text += pattern.slice(index, close + 2);
      index = close + 2;
      continue;
    }
    if (char === '\\' && index + 1 < pattern.length) {
      text += pattern.slice(index, index + 2);
      index += 2;
      continue;
    }
    text += char;
    index += 1;
  }
  // The built-in rejects an unterminated bracket outright; falling back lets
  // it produce that error itself.
  return null;
}

/**
 * Rewrite a Basic Regular Expression as a Rust regex.
 *
 * Returns `null` for anything with no equivalent: a backreference, an
 * unterminated bracket, or a trailing backslash.
 */
export function breToRustRegex(pattern: string): string | null {
  let out = '';
  let index = 0;
  // `*` is a quantifier only after something to repeat. At the start of the
  // pattern, after `\(` or `\|`, or after a `^` anchor or a literal `*`, it is
  // a literal asterisk.
  let atStart = true;

  while (index < pattern.length) {
    const char = pattern[index] as string;

    if (char === '\\') {
      const next = pattern[index + 1];
      if (next === undefined) return null;
      // Rust's regex crate has no backreferences, by design.
      if (next >= '1' && next <= '9') return null;
      index += 2;
      if (next === '(' || next === '|') {
        out += next;
        atStart = true;
        continue;
      }
      atStart = false;
      if (next === ')') {
        out += ')';
      } else if (next === '{') {
        // `\{n\}` and `\{n,m\}` are intervals; any other `\{` is a literal.
        const interval = /^(\d+)(,(\d*))?\\\}/.exec(pattern.slice(index));
        if (interval) {
          out += interval[2] === undefined ? `{${interval[1]}}` : `{${interval[1]},${interval[3]}}`;
          index += interval[0].length;
        } else {
          out += '\\{';
        }
      } else if (LITERAL_WHEN_ESCAPED.has(next)) {
        out += next;
      } else {
        // Everything else keeps its escape: `\.`, `\+` and `\?` are literals
        // in both dialects, and `\w`, `\s`, `\b` already agree.
        out += `\\${next}`;
      }
      continue;
    }

    if (char === '[') {
      const bracket = readBracket(pattern, index);
      if (!bracket) return null;
      out += bracket.text;
      index = bracket.next;
      atStart = false;
      continue;
    }

    index += 1;
    if (char === '*' && atStart) {
      out += '\\*';
    } else if (char === '^') {
      out += atStart ? '^' : '\\^';
    } else if (char === '$') {
      // An anchor at the end of the pattern or of a group; a literal elsewhere.
      const closesGroup = pattern[index] === '\\' && pattern[index + 1] === ')';
      out += index === pattern.length || closesGroup ? '$' : '\\$';
      atStart = false;
    } else {
      out += LITERAL_UNESCAPED.has(char) ? `\\${char}` : char;
      atStart = false;
    }
  }

  return out;
}

/**
 * Rewrite an Extended Regular Expression as a Rust regex.
 *
 * The two dialects agree on structure, so the pattern passes through almost
 * unchanged. Only the escapes need attention: a backreference cannot be
 * expressed at all, and `\<` and `\>` are literal angle brackets here but word
 * boundaries in Rust's regex.
 */
export function ereToRustRegex(pattern: string): string | null {
  let out = '';
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index] as string;
    if (char !== '\\') {
      out += char;
      index += 1;
      continue;
    }
    const next = pattern[index + 1];
    if (next === undefined) return null;
    if (next >= '1' && next <= '9') return null;
    out += LITERAL_WHEN_ESCAPED.has(next) ? next : `\\${next}`;
    index += 2;
  }

  return out;
}
