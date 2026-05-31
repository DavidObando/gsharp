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
    /\b(?:async|await|break|case|catch|chan|class|const|continue|default|defer|else|enum|fallthrough|finally|for|func|go|goto|if|import|interface|internal|is|let|map|open|operator|override|package|private|public|range|return|scope|sealed|select|sequence|struct|switch|throw|try|type|using|var)\b/;

  // Contextual keywords: ordinary identifiers that act as keywords in context.
  const contextualKeywords =
    /\b(?:record|data|inline|get|set|yield|in|out|where)\b/;

  // Built-in primitive type names (TypeSymbol). Width-bearing names are
  // canonical; there is intentionally no `int`/`long`/`byte` alias.
  const builtinTypes =
    /\b(?:bool|uint8|int8|int16|uint16|int32|uint32|int64|uint64|nint|nuint|float32|float64|decimal|char|string|object|void)\b/;

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
          pattern: /\\(?:u[0-9a-fA-F]{4}|x[0-9a-fA-F]+|.)/,
          alias: 'char',
        },
      },
    },
    char: {
      pattern: /'(?:\\(?:u[0-9a-fA-F]{4}|x[0-9a-fA-F]+|.)|[^'\\\r\n])'/,
      greedy: true,
    },
    'class-name': [
      {
        // Type after declaration keywords.
        pattern:
          /(\b(?:class|struct|enum|interface|record|type)\s+)[A-Za-z_]\w*/,
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
      /\+\+|--|<-|->|:=|&&|\|\||==|!=|<=|>=|<<|>>|\.\.\.|&\^|[+\-*/%&|^!<>=]=?|[~?:.]/,
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
