/**
 * Swizzled from @docusaurus/theme-classic to register the custom G# (gsharp)
 * Prism grammar in addition to the configured built-in additionalLanguages.
 *
 * The grammar is implementation-grounded: keywords, contextual keywords and
 * built-in primitive type names are taken from the G# compiler
 * (src/Core/CodeAnalysis/Syntax/SyntaxFacts.gs and
 *  src/Core/CodeAnalysis/Symbols/TypeSymbol.gs).
 */

import siteConfig from '@generated/docusaurus.config';
import type * as PrismNamespace from 'prismjs';
import type {Optional} from 'utility-types';

const identifier = /\$?[\p{L}_][\p{L}\p{Nd}_]*/uy;
// Reserved keywords recognized by the lexer (SyntaxFacts.GetKeywordKind).
const keywords =
  /\b(?:as|async|await|break|case|catch|chan|class|const|continue|default|defer|do|else|enum|fallthrough|finally|for|func|go|goto|guard|if|import|interface|internal|is|let|lock|map|open|operator|override|package|private|protected|public|range|rethrow|return|scope|sealed|select|sequence|struct|suspend|switch|throw|try|using|var|while)\b/;

function wordAt(source: string, index: number): string {
  identifier.lastIndex = index;
  return identifier.exec(source)?.[0] ?? '';
}

function skipTrivia(source: string, index: number): number {
  while (index < source.length) {
    if (/\s/.test(source[index])) index++;
    else if (source.startsWith('//', index)) {
      index += 2;
      while (index < source.length && !/[\r\n]/.test(source[index])) index++;
    } else if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2);
      index = close < 0 ? source.length : close + 2;
    } else break;
  }
  return index;
}

function quoteMode(source: string, index: number): string {
  return source[index] === '"' && source[index - 1] === 'b' &&
    !/[\p{L}\p{Nd}_$]/u.test(source[index - 2] ?? '') ? 'byte' : source[index];
}

// Prism calls RegExp.exec for both top-level and nested grammar patterns.
// Scan delimiters instead of approximating a fixed brace depth with regexes.
function balancedPattern(start: RegExp): RegExp {
  const pattern = new RegExp(start.source, 'gu');
  pattern.exec = function(source: string): RegExpExecArray | null {
    start.lastIndex = this.lastIndex;
    let match: RegExpExecArray | null;
    while ((match = start.exec(source))) {
      const first = match.index + (match[0] === '${' ? 1 : 0);
      const closing: Record<string, string> = {'{': '}', '[': ']', '(': ')'};
      const stack = [closing[source[first]] ?? quoteMode(source, first)];
      let i = first + 1;
      for (; i < source.length && stack.length; i++) {
        const c = source[i];
        const top = stack[stack.length - 1];
        if (top === '"' || top === "'" || top === '`' || top === 'byte') {
          if (c === (top === 'byte' ? '"' : top)) stack.pop();
          else if (top !== '`' && c === '\\') i++;
          else if (top === '"' && c === '$' && source[i + 1] === '$') i++;
          else if (top === '"' && c === '$' && source[i + 1] === '{') {
            stack.push('}');
            i++;
          } else if (top !== '`' && /[\r\n]/.test(c)) break;
        } else if (c === '/' && /[/*]/.test(source[i + 1] ?? '')) {
          i = skipTrivia(source, i) - 1;
        } else if (c === '"' || c === "'" || c === '`') {
          stack.push(quoteMode(source, i));
        } else if ('{[('.includes(c)) {
          stack.push(c === '{' ? '}' : c === '[' ? ']' : ')');
        } else if (c === top) {
          stack.pop();
        }
      }
      if (!stack.length) {
        match[0] = source.slice(match.index, i);
        this.lastIndex = i;
        return match;
      }
    }
    this.lastIndex = 0;
    return null;
  };
  return pattern;
}

function groupEnd(source: string, index: number): number {
  const group = balancedPattern(/["'`([{]/gu);
  group.lastIndex = index;
  const match = group.exec(source);
  return match?.index === index ? group.lastIndex : index;
}

function typeName(word: string): boolean {
  return !!word && (word.startsWith('$') ||
    (keywords.exec(word)?.[0] !== word && !['nil', 'true', 'false'].includes(word)));
}

function arrayPrefixEnd(source: string, index: number): number {
  let cursor = skipTrivia(source, index + 1);
  const length = /^[0-9][0-9a-zA-Z_]*/.exec(source.slice(cursor));
  if (length) cursor = skipTrivia(source, cursor + length[0].length);
  else while (source[cursor] === ',') cursor = skipTrivia(source, cursor + 1);
  return source[cursor] === ']' ? cursor + 1 : index;
}

// Validate delimited type clauses instead of treating every balanced group as
// a type: list patterns and index expressions have different token productions.
function typeListEnd(source: string, index: number, depth: number, tuple = false, pointers = false, signature = false): number {
  const close = source[index] === '(' ? ')' : ']';
  let cursor = skipTrivia(source, index + 1);
  let count = 0;
  let named = false;
  let modifiers = false;
  while (cursor < source.length && source[cursor] !== close) {
    if (source.startsWith('...', cursor) && close === ')') cursor += 3;
    let end = typeEnd(source, cursor, depth + 1, pointers);
    if (end > cursor) end = skipTrivia(source, end);
    if (end <= cursor || (source[end] !== ',' && source[end] !== close)) {
      if (close !== ')') return index;
      const name = wordAt(source, cursor);
      if (!typeName(name)) return index;
      cursor = skipTrivia(source, cursor + name.length);
      const modifier = ['ref', 'out', 'in'].includes(name);
      if (modifier && source.startsWith('...', cursor)) cursor += 3;
      end = typeEnd(source, cursor, depth + 1, pointers);
      if (end <= cursor) return index;
      end = skipTrivia(source, end);
      if (modifier) modifiers = true;
      else named = true;
    }
    count++;
    if (source[end] === close) {
      const parameters = signature || source.startsWith('->', skipTrivia(source, end + 1));
      if (parameters && named) return index;
      return tuple && (named || (modifiers && !parameters)) && count === 1 ? index : end + 1;
    }
    if (source[end] !== ',') return index;
    cursor = skipTrivia(source, end + 1);
  }
  return (close === ')' || count > 0) && source[cursor] === close ? cursor + 1 : index;
}

// Read a type only in a type position (Parser.TypeClauses), never infer it
// from the operator that follows '?'. Validate delimiter contents lexically.
function typeEnd(source: string, index: number, depth = 0, pointers = true): number {
  const start = index;
  // ponytail: bound speculative type depth; deeper input falls back to balanced expression scanning.
  if (depth > 128) return start;
  let managedPointer = false;
  while (index < source.length) {
    index = skipTrivia(source, index);
    if (source[index] === '*') {
      managedPointer = wordAt(source, skipTrivia(source, index + 1)) === 'func';
      if (!pointers && !managedPointer) return start;
      index++;
      continue;
    }
    if (source[index] === '[') {
      const end = arrayPrefixEnd(source, index);
      if (end === index) return start;
      index = skipTrivia(source, end);
      if (source[index] === '?' && source[index + 1] !== '?') index++;
      continue;
    }
    const word = wordAt(source, index);
    const afterWord = skipTrivia(source, index + word.length);
    const nextWord = wordAt(source, afterWord);
    const signature = word === 'func' ||
      (word === 'unmanaged' && (source[afterWord] === '[' || source[afterWord] === '('));
    if ((word === 'readonly' && ['managed', 'slice'].includes(nextWord)) ||
      (word === 'async' && (['func', 'sequence'].includes(nextWord) || source[afterWord] === '(')) ||
      (['in', 'out'].includes(word) && nextWord === 'chan')) {
      index = afterWord;
      continue;
    }
    if (word && !typeName(word) && !['func', 'map', 'chan', 'sequence'].includes(word)) return start;
    if (word) {
      index += word.length;
      while (true) {
        const next = skipTrivia(source, index);
        if (source[next] === '[') {
          const end = typeListEnd(source, next, depth);
          if (end === next) return start;
          index = end;
        } else if (source[next] === '.' && wordAt(source, skipTrivia(source, next + 1))) {
          index = skipTrivia(source, next + 1);
          index += wordAt(source, index).length;
        } else break;
      }
      if (!signature) {
        const suffix = skipTrivia(source, index);
        return source[suffix] === '?' && !/[?.]/.test(source[suffix + 1] ?? '')
          ? suffix + 1 : index;
      }
    }
    index = skipTrivia(source, index);
    if (source[index] !== '(') return start;
    pointers = word === 'unmanaged' || managedPointer || (!word && pointers);
    const end = typeListEnd(source, index, depth, !word, pointers, !!word);
    if (end === index) return start;
    index = skipTrivia(source, end);
    if (source[index] === '?' && !/[?.]/.test(source[index + 1] ?? '')) return index + 1;
    if (source.startsWith('->', index)) index += 2;
    else if (!word) return end;
    const result = signatureReturnEnd(source, index, depth + 1, pointers);
    return result > skipTrivia(source, index) ? result : end;
  }
  return start;
}

function signatureReturnEnd(source: string, index: number, depth = 0, pointers = true, literal = false): number {
  index = skipTrivia(source, index);
  if (literal && wordAt(source, index) === 'ref') {
    let next = skipTrivia(source, index + 3);
    if (wordAt(source, next) === 'readonly') {
      const after = skipTrivia(source, next + 8);
      if (typeEnd(source, after, depth, pointers) > after) next = after;
    }
    if (typeEnd(source, next, depth, pointers) > next) index = next;
  }
  return typeEnd(source, index, depth, pointers);
}

function patternTypeEnd(source: string, index: number): number {
  const end = typeEnd(source, index);
  const next = skipTrivia(source, end);
  const word = wordAt(source, next);
  // CanFollowBareTypePattern plus an optional identifier designation.
  return end > index && (next === source.length ||
    /[{}\]),:;?+\-*/%&|^<>=!]/.test(source[next] ?? '') ||
    typeName(word) || ['as', 'is', 'else', 'case', 'default'].includes(word)) ? end : index;
}

// Pattern heads follow Parser.Patterns: combinators introduce another primary;
// discard, constants and designations are not type names with nullable tails.
function patternEnd(source: string, index: number): number {
  let primary = true;
  let designation = false;
  while (index < source.length) {
    index = skipTrivia(source, index);
    const word = wordAt(source, index);
    if (primary && word === 'not') {
      index += word.length;
      continue;
    }
    if (!primary && (word === 'and' || word === 'or')) {
      index += word.length;
      primary = true;
      designation = false;
      continue;
    }
    if (!primary) {
      if (designation && source[index] === '{') {
        const end = groupEnd(source, index);
        if (end === index) return index;
        index = end;
        continue;
      }
      if (designation && word && !['is', 'as', 'not', 'when'].includes(word)) {
        index += word.length;
        designation = false;
        continue;
      }
      const end = expressionEnd(source, index, true);
      if (end <= index) return index;
      index = end;
      designation = false;
      continue;
    }
    const relational = /^(?:<=?|>=?|==|!=)/.exec(source.slice(index));
    if (relational) {
      index = expressionEnd(source, index + relational[0].length, true);
      designation = false;
    } else if (word === 'var') {
      index = skipTrivia(source, index + word.length);
      index += wordAt(source, index).length;
      designation = false;
    } else if (['nil', 'true', 'false'].includes(word) ||
      (word === '_' && !['.', '('].includes(source[skipTrivia(source, index + 1)]))) {
      index += word.length;
      designation = false;
    } else if (word || '[(*'.includes(source[index] ?? '\0')) {
      const end = patternTypeEnd(source, index);
      if (end > index) {
        index = end;
        designation = true;
      } else {
        const operand = '[('.includes(source[index] ?? '\0')
          ? groupEnd(source, index) : expressionEnd(source, index, true);
        if (operand <= index) return index;
        index = operand;
        designation = false;
      }
    } else if ('("\'`[{'.includes(source[index] ?? '\0')) {
      const end = groupEnd(source, index);
      if (end === index) return index;
      index = end;
      designation = source[index - 1] === '}' || source[index - 1] === ']';
    } else {
      const end = expressionEnd(source, index, true);
      if (end <= index) return index;
      index = end;
      designation = false;
    }
    primary = false;
  }
  return index;
}

function postfixCallAt(source: string, index: number): boolean {
  // ParsePostfixChain permits adjacent ?( after every postfix receiver.
  return source.startsWith('?(', index) && /[\p{L}\p{Nd}_\])}"'`!]/u.test(source[index - 1] ?? '');
}

function expressionEnd(source: string, cursor: number, patternOperand = false): number {
  let memberName = false;
  let conditionals = 0;
  let operand: 'none' | 'name' | 'value' | 'lambda' = 'none';
  while (cursor < source.length) {
    cursor = skipTrivia(source, cursor);
    const word = wordAt(source, cursor);
    if (word) {
      if (patternOperand && !memberName && !conditionals && (word === 'and' || word === 'or')) return cursor;
      const start = cursor;
      cursor += word.length;
      if (!memberName && word === 'as') {
        cursor = typeEnd(source, cursor);
        operand = 'value';
      } else if (!memberName && word === 'let') {
        const name = skipTrivia(source, cursor);
        cursor = skipTrivia(source, name + wordAt(source, name).length);
        cursor = typeEnd(source, cursor);
        operand = 'none';
      } else if (!memberName && word === 'is') {
        cursor = patternEnd(source, cursor);
        operand = 'value';
      } else if (!memberName && word === 'func' && source[skipTrivia(source, cursor)] === '(') {
        const parameters = groupEnd(source, skipTrivia(source, cursor));
        cursor = signatureReturnEnd(source, parameters, 0, true, true);
        operand = 'none';
      } else if (!memberName && (['map', 'chan'].includes(word) ||
        (word === 'readonly' && ['managed', 'slice'].includes(wordAt(source, skipTrivia(source, cursor)))))) {
        const end = typeEnd(source, start);
        const next = skipTrivia(source, end);
        if (end > start && (source[next] === '{' || source[next] === '(')) cursor = end;
        operand = 'name';
      } else if (!memberName && word === 'object') {
        const header = skipTrivia(source, cursor);
        if (source[header] === ':') cursor = header + 1;
        operand = 'name';
      } else {
        operand = memberName || ['nil', 'true', 'false'].includes(word) ? 'value'
          : !word.startsWith('$') && keywords.test(word) ? 'none' : 'name';
      }
      memberName = false;
      continue;
    }
    const c = source[cursor];
    if (c === '[' && operand === 'none') {
      const prefix = groupEnd(source, cursor);
      let end = typeEnd(source, cursor);
      if (end === cursor) end = typeEnd(source, skipTrivia(source, prefix));
      if (end > cursor && source[skipTrivia(source, end)] === '{') {
        cursor = end;
        continue;
      }
    }
    if (c && '"\'`([{'.includes(c)) {
      const end = groupEnd(source, cursor);
      if (end === cursor) break;
      cursor = end;
      operand = c === '(' && operand === 'none' ? 'lambda' : 'value';
      memberName = false;
      continue;
    }
    if (source.startsWith('->', cursor)) {
      memberName = operand === 'value';
      operand = 'none';
      cursor += 2;
      continue;
    }
    if (source.startsWith('!!', cursor) && operand !== 'none') {
      operand = 'value';
      cursor += 2;
      continue;
    }
    memberName = c === '.';
    operand = c && /[0-9]/.test(c) ? 'value' : 'none';
    if (c === '?') {
      if (source[cursor + 1] === '?' || source[cursor + 1] === '.') {
        memberName = source[cursor + 1] === '.';
        cursor++;
      } else if (source[cursor + 1] === '[' || postfixCallAt(source, cursor)) operand = 'value';
      else conditionals++;
    } else if (c === ':' && conditionals) conditionals--;
    else if (c === ':' || (patternOperand && c && ',;})]'.includes(c))) return cursor;
    cursor++;
  }
  return cursor;
}

function interpolationFormatPattern(): RegExp {
  const pattern = /:[\s\S]*$/g;
  pattern.exec = function(source: string): RegExpExecArray | null {
    const cursor = expressionEnd(source, 0);
    if (source[cursor] === ':' && cursor >= this.lastIndex) {
      const result = /:[\s\S]*$/g;
      result.lastIndex = cursor;
      const match = result.exec(source);
      this.lastIndex = source.length;
      return match;
    }
    this.lastIndex = 0;
    return null;
  };
  return pattern;
}

function registerGSharp(Prism: typeof PrismNamespace): void {
  const word = (pattern: RegExp): RegExp => new RegExp(
    `(?<![\\p{L}\\p{Nd}_$])(?:${pattern.source.replace(/\\b/g, '')})(?![\\p{L}\\p{Nd}_])`,
    'u',
  );
  // Contextual keywords: ordinary identifiers that act as keywords in context.
  // Grounded in the parser's contextual recognitions (Text == "…" checks),
  // covering member/declaration words (`prop`, `event`, `delegate`, `data`,
  // `inline`, `shared`, `convenience`, `deinit`), accessors (`get`/`set`/`add`/
  // `remove`/`raise`), parameter modifiers (`in`/`out`/`ref`/`scoped`/`params`),
  // conversion operators (`explicit`/`implicit`), pattern combinators
  // (`and`/`or`/`not`), the `init()` constructor constraint (renamed from
  // `new()` by ADR-0097 / issue #997), the unsafe/low-level words
  // (`unsafe`/`fixed`/`stackalloc`/`unmanaged`/`sizeof`), partial declarations,
  // the overflow-context
  // markers `checked`/`unchecked` (issue #1881; `lock` is a reserved keyword,
  // not contextual — see `keywords` above), and the named-delegate
  // declaration keyword `delegate` (issue #3510).
  // `record` was removed in v0.2; the lexer still recognises it so the parser
  // can emit the GS0307 migration diagnostic, so we keep it here for fidelity.
  // `type` stopped being a reserved keyword in issue #3510: it now parses
  // contextually, only at member position. `type Name = Target` remains a
  // valid, currently-accepted erased-alias declaration; only the delegate
  // specialization, `type Name = delegate func(...)`, is a retired recovery
  // spelling superseded by the canonical `delegate Name(...) R;`
  // declaration.
  // ADR-0165's explicit-extension-receiver marker `extension` (issue #3357)
  // was retired by ADR-0182 (issue #4240): every receiver clause is
  // unconditionally an extension now, so `extension` is an ordinary
  // identifier again — it is deliberately absent from this list.
  const contextualKeywords =
    /\b(?:abstract|adapt|add|and|any|array|base|cancelled|cast|checked|comparable|convenience|data|deinit|delegate|event|explicit|fixed|get|implicit|in|init|inline|make|managed|nameof|not|or|out|params|partial|prop|raise|readonly|record|ref|remove|scoped|set|shared|sizeof|slice|stackalloc|this|type|typeof|unchecked|unmanaged|unsafe|when|with|yield)\b/;

  // Built-in primitive type names (TypeSymbol). Width-bearing names are
  // canonical; friendly aliases (`int`, `long`, etc.) are accepted by the
  // binder but resolve to the canonical names — we highlight both so source
  // that uses either spelling renders consistently.
  const builtinTypes =
    /\b(?:bool|byte|bytestring|char|decimal|double|float|float32|float64|int|int8|int16|int32|int64|long|nint|nuint|object|sbyte|short|string|uint|uint8|uint16|uint32|uint64|ulong|ushort|void)\b/;

  Prism.languages.gsharp = {
    comment: [
      {
        pattern: /\/\*[\s\S]*?\*\//,
        greedy: true,
      },
      {
        pattern: /\/\/.*/,
        greedy: true,
      },
    ],
    // Raw strings: ` ... ` (no escapes).
    'raw-string': {
      pattern: /`[^`]*`/,
      greedy: true,
      alias: 'string',
    },
    'byte-string': {
      pattern: /(^|[^\p{L}\p{N}_$])b"(?:\\.|[^"\\\r\n])*"/u,
      lookbehind: true,
      greedy: true,
      alias: 'string',
      inside: {
        'byte-escape': {
          pattern: /\\(?:["\\0nrt]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/,
          alias: 'char',
        },
      },
    },
    // Interpolated/regular strings, including multiline interpolation holes.
    string: {
      pattern: balancedPattern(/"/gu),
      greedy: true,
      inside: {
        'dollar-escape': {
          pattern: /\$\$/,
          alias: 'char',
        },
        interpolation: {
          pattern: balancedPattern(/\$\{/gu),
          greedy: true,
          inside: {
            'interpolation-punctuation': {
              pattern: /^\$\{|\}$/,
              alias: 'punctuation',
            },
          },
        },
        'interpolation-identifier': {
          pattern: /\$[\p{L}_][\p{L}\p{Nd}_]*/u,
          alias: 'interpolation',
        },
        'string-escape': {
          pattern: /\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{1,4}|['"\\0abfnrtv])/,
          alias: 'char',
        },
      },
    },
    char: {
      pattern: /'(?:\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{1,4}|['"\\0abfnrtv])|[^'\\\r\n])'/,
      greedy: true,
    },
    'assembly-annotation': {
      pattern: /(@assembly:\s*)[\p{L}_][\p{L}\p{Nd}_]*/u,
      lookbehind: true,
      alias: 'attr-name',
    },
    'annotation-target': {
      pattern: /(@)assembly(?=:)/,
      lookbehind: true,
      alias: 'keyword',
    },
    annotation: {
      pattern: /@[\p{L}_][\p{L}\p{Nd}_]*/u,
      alias: 'attr-name',
    },
    'explicit-interface-declaration': {
      pattern:
        /(?<![\p{L}\p{Nd}_$])(?:func|prop|event)\s+\((?:\$?[\p{L}_][\p{L}\p{Nd}_]*\.)*\$?[\p{L}_][\p{L}\p{Nd}_]*(?:\[[^\]\r\n]+\])?\)\s+\$?[\p{L}_][\p{L}\p{Nd}_]*/u,
      inside: {
        function: {
          pattern: /(^func\s+\([^)]+\)\s+)\$?[\p{L}_][\p{L}\p{Nd}_]*$/u,
          lookbehind: true,
        },
        property: {
          pattern:
            /(^(?:prop|event)\s+\([^)]+\)\s+)\$?[\p{L}_][\p{L}\p{Nd}_]*$/u,
          lookbehind: true,
        },
        'class-name': {
          pattern:
            /(\()(?:\$?[\p{L}_][\p{L}\p{Nd}_]*\.)*\$?[\p{L}_][\p{L}\p{Nd}_]*(?:\[[^\]\r\n]+\])?(?=\))/u,
          lookbehind: true,
        },
        keyword: /^(?:func|prop|event)\b/,
        punctuation: /[()]/,
      },
    },
    'function-declaration': {
      pattern: /((?<![\p{L}\p{Nd}_$])(?:func|sequence)\s+)\$?[\p{L}_][\p{L}\p{Nd}_]*/u,
      lookbehind: true,
      alias: 'function',
    },
    'class-name': [
      {
        // Type after declaration keywords. `delegate Name(...)` is the
        // canonical named-delegate-type declaration (issue #3510); `type` is
        // kept for the retired `type Name = delegate func(...)` recovery form.
        pattern:
          /((?<![\p{L}\p{Nd}_$])(?:class|struct|enum|interface|type|delegate)\s+)\$?[\p{L}_][\p{L}\p{Nd}_]*/u,
        lookbehind: true,
      },
      {
        // Conventionally PascalCase identifiers read as types/CLR names.
        pattern: /(?<![\p{L}\p{Nd}_$])[A-Z][\p{L}\p{Nd}_]*(?![\p{L}\p{Nd}_])/u,
      },
    ],
    'escaped-identifier': {
      pattern: /\$[\p{L}_][\p{L}\p{Nd}_]*/u,
      alias: 'identifier',
    },
    keyword: word(keywords),
    'contextual-keyword': {
      pattern: word(contextualKeywords),
      alias: 'keyword',
    },
    'anonymous-object': {
      pattern: /(?<![\p{L}\p{Nd}_$])object(?=\s*(?:\{|:))/u,
      alias: 'keyword',
    },
    'builtin-type': {
      pattern: word(builtinTypes),
      alias: 'builtin',
    },
    boolean: word(/\b(?:true|false)\b/),
    'nil-literal': {
      pattern: word(/\bnil\b/),
      alias: 'constant',
    },
    number: /(?<![\p{L}\p{Nd}_$])(?:0[xX]_*[0-9a-fA-F](?:_*[0-9a-fA-F])*(?:[uU][lL]?|[lL][uU]?)?|0[oO]_*[0-7](?:_*[0-7])*(?:[uU][lL]?|[lL][uU]?)?|0[bB]_*[01](?:_*[01])*(?:[uU][lL]?|[lL][uU]?)?|(?:[0-9](?:_*[0-9])*(?:\.[0-9](?:_*[0-9])*)?|(?<!\.)\.[0-9](?:_*[0-9])*)(?:[eE][+-]?[0-9](?:_*[0-9])*)?(?:[uU][lL]?|[lL][uU]?|[fFdDmM])?)(?![\p{L}\p{Nd}_])/u,
    // Function/attribute names at call/declaration sites.
    function: /[\p{L}_][\p{L}\p{Nd}_]*(?=\s*\()/u,
    identifier: /[\p{L}_][\p{L}\p{Nd}_]*/u,
    operator:
      // Order matters in Prism alternations — list multi-character operators
      // first so they win over their single-character prefixes.
      /\?\?=|\?\?|\?\.|\?\[|!!|\+\+|--|<-|->|=>|:=|&&|\|\||==|!=|<=|>=|<<=|>>>=|>>=|<<|>>>|>>|\.\.\.|\.\.|&\^=|&\^|[+\-*/%&|^!<>=]=?|@|[~?:.]/,
    punctuation: /[{}[\];(),]/,
  };

  // Allow interpolation holes to recursively use the gsharp grammar.
  // (Prism's TS types are loose here, so we cast through `any`.)
  const gsharp = Prism.languages.gsharp as Record<string, any>;
  const stringInside = gsharp.string?.inside as Record<string, any> | undefined;
  if (stringInside && stringInside.interpolation) {
    stringInside.interpolation.inside = {
      'interpolation-punctuation': {
        pattern: /^\$\{|\}$/,
        alias: 'punctuation',
      },
      format: {
        pattern: interpolationFormatPattern(),
        inside: {punctuation: /^:/},
        alias: 'string',
      },
      rest: Prism.languages.gsharp,
    };
  }

  // Common aliases.
  Prism.languages.gs = Prism.languages.gsharp;
  Prism.languages['g#'] = Prism.languages.gsharp;
}

export default function prismIncludeLanguages(
  PrismObject: typeof PrismNamespace,
): void {
  const {
    themeConfig: {prism},
  } = siteConfig;
  const {additionalLanguages} = prism as {additionalLanguages: string[]};

  const PrismBefore = globalThis.Prism;
  globalThis.Prism = PrismObject;

  additionalLanguages.forEach((lang) => {
    if (lang === 'php') {
      // eslint-disable-next-line global-require
      require('prismjs/components/prism-markup-templating.js');
    }
    // eslint-disable-next-line global-require, import/no-dynamic-require
    require(`prismjs/components/prism-${lang}`);
  });

  registerGSharp(PrismObject);

  // Clean up and eventually restore former globalThis.Prism object (if any)
  delete (globalThis as Optional<typeof globalThis, 'Prism'>).Prism;
  if (typeof PrismBefore !== 'undefined') {
    globalThis.Prism = PrismObject;
  }
}
