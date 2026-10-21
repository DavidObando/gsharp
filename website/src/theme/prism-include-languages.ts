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

// Prism calls RegExp.exec for both top-level and nested grammar patterns.
// Scan delimiters instead of approximating a fixed brace depth with regexes.
function balancedPattern(start: RegExp): RegExp {
  const pattern = new RegExp(start.source, 'gu');
  pattern.exec = function(source: string): RegExpExecArray | null {
    start.lastIndex = this.lastIndex;
    let match: RegExpExecArray | null;
    while ((match = start.exec(source))) {
      if (match[0].startsWith('/')) {
        this.lastIndex = start.lastIndex;
        return match;
      }
      const first = match.index + (match[0] === '${' ? 1 : 0);
      const closing: Record<string, string> = {'{': '}', '[': ']', '(': ')', '?': ':'};
      const stack = [closing[source[first]] ?? source[first]];
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
        } else if (c === '/' && source[i + 1] === '/') {
          const newline = source.indexOf('\n', i + 2);
          i = newline < 0 ? source.length : newline;
        } else if (c === '/' && source[i + 1] === '*') {
          const close = source.indexOf('*/', i + 2);
          i = close < 0 ? source.length : close + 1;
        } else if (c === '"' || c === "'" || c === '`') {
          stack.push(c === '"' && source[i - 1] === 'b' &&
            !/[\p{L}\p{Nd}_$]/u.test(source[i - 2] ?? '') ? 'byte' : c);
        } else if ('{[('.includes(c)) {
          stack.push(c === '{' ? '}' : c === '[' ? ']' : ')');
        } else if (source[first] === '?' && top === ':' && c === '?' &&
          !/[?.[]/.test(source[i + 1] ?? '') && source[i - 1] !== '?') {
          stack.push(':');
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

function interpolationFormatPattern(): RegExp {
  const pattern = /:[\s\S]*$/g;
  pattern.exec = function(source: string): RegExpExecArray | null {
    const opaque = balancedPattern(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|["'`([{]|(?<!\?)\?(?![?.\[])/gu);
    let cursor = 0;
    while (cursor < source.length) {
      opaque.lastIndex = cursor;
      const nested = opaque.exec(source);
      const colon = source.indexOf(':', cursor);
      if (colon < 0) break;
      if (nested && nested.index < colon) {
        cursor = opaque.lastIndex;
      } else if (colon >= this.lastIndex) {
        const result = /:[\s\S]*$/g;
        result.lastIndex = colon;
        const match = result.exec(source);
        this.lastIndex = source.length;
        return match;
      } else {
        cursor = colon + 1;
      }
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
  // Reserved keywords recognized by the lexer (SyntaxFacts.GetKeywordKind).
  const keywords =
    /\b(?:as|async|await|break|case|catch|chan|class|const|continue|default|defer|do|else|enum|fallthrough|finally|for|func|go|goto|guard|if|import|interface|internal|is|let|lock|map|open|operator|override|package|private|protected|public|range|rethrow|return|scope|sealed|select|sequence|struct|suspend|switch|throw|try|using|var|while)\b/;

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
        pattern: /^\$\{?|\}$/,
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
