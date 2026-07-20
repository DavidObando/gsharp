/**
 * Swizzled from @docusaurus/theme-classic to register the custom G# (gsharp)
 * Prism grammar in addition to the configured built-in additionalLanguages.
 *
 * The grammar is implementation-grounded: keywords, contextual keywords and
 * built-in primitive type names are taken from the G# compiler
 * (src/Core/CodeAnalysis/Syntax/SyntaxFacts.cs and
 *  src/Core/CodeAnalysis/Symbols/TypeSymbol.cs).
 */

import siteConfig from '@generated/docusaurus.config';
import type * as PrismNamespace from 'prismjs';
import type {Optional} from 'utility-types';

function registerGSharp(Prism: typeof PrismNamespace): void {
  // Reserved keywords recognized by the lexer (SyntaxFacts.GetKeywordKind).
  const keywords =
    /\b(?:as|async|await|break|case|catch|chan|class|const|continue|default|defer|do|else|enum|fallthrough|finally|for|func|go|goto|guard|if|import|interface|internal|is|let|lock|map|open|operator|override|package|private|protected|public|range|return|scope|sealed|select|sequence|struct|switch|throw|try|type|using|var|while)\b/;

  // Contextual keywords: ordinary identifiers that act as keywords in context.
  // Grounded in the parser's contextual recognitions (Text == "…" checks),
  // covering member/declaration words (`prop`, `event`, `delegate`, `data`,
  // `inline`, `shared`, `convenience`, `deinit`), accessors (`get`/`set`/`add`/
  // `remove`/`raise`), parameter modifiers (`in`/`out`/`ref`/`scoped`/`params`),
  // conversion operators (`explicit`/`implicit`), pattern combinators
  // (`and`/`or`/`not`), the `init()` constructor constraint (renamed from
  // `new()` by ADR-0097 / issue #997), the unsafe/low-level words
  // (`unsafe`/`fixed`/`stackalloc`/`unmanaged`/`sizeof`), partial declarations,
  // and the overflow-context
  // markers `checked`/`unchecked` (issue #1881; `lock` is a reserved keyword,
  // not contextual — see `keywords` above).
  // `record` was removed in v0.2; the lexer still recognises it so the parser
  // can emit the GS0307 migration diagnostic, so we keep it here for fidelity.
  const contextualKeywords =
    /\b(?:add|and|base|checked|convenience|data|deinit|delegate|event|explicit|fixed|get|implicit|in|init|inline|make|nameof|not|or|out|params|partial|prop|raise|record|ref|remove|scoped|set|shared|sizeof|stackalloc|this|typeof|unchecked|unmanaged|unsafe|when|with|yield)\b/;

  // Built-in primitive type names (TypeSymbol). Width-bearing names are
  // canonical; friendly aliases (`int`, `long`, etc.) are accepted by the
  // binder but resolve to the canonical names — we highlight both so source
  // that uses either spelling renders consistently.
  const builtinTypes =
    /\b(?:bool|byte|char|decimal|double|float|float32|float64|int|int8|int16|int32|int64|long|nint|nuint|object|sbyte|short|string|uint|uint8|uint16|uint32|uint64|ulong|ushort|void)\b/;

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
    // Interpolated/regular double-quoted strings with escapes and ${...} holes.
    string: {
      pattern: /"(?:\\.|\$\{[^{}]*\}|[^"\\\r\n])*"/,
      greedy: true,
      inside: {
        interpolation: {
          pattern: /\$\{[^{}]*\}/,
          inside: {
            'interpolation-punctuation': {
              pattern: /^\$\{|\}$/,
              alias: 'punctuation',
            },
          },
        },
        'string-escape': {
          pattern: /\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{1,4}|.)/,
          alias: 'char',
        },
      },
    },
    char: {
      pattern: /'(?:\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{1,4}|.)|[^'\\\r\n])'/,
      greedy: true,
    },
    'assembly-annotation': {
      pattern: /(@assembly:\s*)[A-Za-z_]\w*/,
      lookbehind: true,
      alias: 'attr-name',
    },
    'annotation-target': {
      pattern: /(@)assembly(?=:)/,
      lookbehind: true,
      alias: 'keyword',
    },
    annotation: {
      pattern: /@[A-Za-z_]\w*/,
      alias: 'attr-name',
    },
    'explicit-interface-declaration': {
      pattern:
        /\b(?:func|prop|event)\s+\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\[[^\]\r\n]+\])?\)\s+(?:this|[A-Za-z_]\w*)/,
      inside: {
        function: {
          pattern: /(^func\s+\([^)]+\)\s+)[A-Za-z_]\w*$/,
          lookbehind: true,
        },
        property: {
          pattern:
            /(^(?:prop|event)\s+\([^)]+\)\s+)(?:this|[A-Za-z_]\w*)$/,
          lookbehind: true,
        },
        'class-name': {
          pattern:
            /(\()[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\[[^\]\r\n]+\])?(?=\))/,
          lookbehind: true,
        },
        keyword: /^(?:func|prop|event)\b/,
        punctuation: /[()]/,
      },
    },
    'class-name': [
      {
        // Type after declaration keywords.
        pattern:
          /(\b(?:class|struct|enum|interface|type)\s+)[A-Za-z_]\w*/,
        lookbehind: true,
      },
      {
        // Conventionally PascalCase identifiers read as types/CLR names.
        pattern: /\b[A-Z]\w*\b/,
      },
    ],
    keyword: keywords,
    'contextual-keyword': {
      pattern: contextualKeywords,
      alias: 'keyword',
    },
    'anonymous-object': {
      pattern: /\bobject(?=\s*(?:\{|:))/,
      alias: 'keyword',
    },
    'builtin-type': {
      pattern: builtinTypes,
      alias: 'builtin',
    },
    boolean: /\b(?:true|false)\b/,
    'nil-literal': {
      pattern: /\bnil\b/,
      alias: 'constant',
    },
    number:
      /\b(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?)(?:[uUlLfFdDmM]{1,2})?\b/,
    // Function/attribute names at call/declaration sites.
    function: /\b[A-Za-z_]\w*(?=\s*[<(])/,
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
