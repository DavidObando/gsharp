import * as fs from 'fs';
import * as path from 'path';
import {Registry, INITIAL, parseRawGrammar} from 'vscode-textmate';
import {loadWASM, OnigScanner, OnigString} from 'vscode-oniguruma';

// Implementation-grounded conformance tests for the G# TextMate grammar.
//
// The reserved keyword set is parsed directly out of the compiler's
// SyntaxFacts.GetKeywordKind so that this test fails if the language adds or
// removes a reserved keyword without the grammar being updated to match.

const repoRoot = path.resolve(__dirname, '../../../..');
const grammarPath = path.resolve(
  __dirname,
  '../../syntaxes/gsharp.tmLanguage.json',
);
const injectionPath = path.resolve(
  __dirname,
  '../../syntaxes/gsharp-markdown-injection.json',
);
const syntaxFactsPath = path.resolve(
  repoRoot,
  'src/Core/CodeAnalysis/Syntax/SyntaxFacts.gs',
);

const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8'));
const cases: {name: string; source: string; tokens: [string, string][]; absent?: [string, string][]; format?: string}[] =
  JSON.parse(fs.readFileSync(path.join(__dirname, 'grammar-cases.json'), 'utf8'));
const reserved = reservedKeywordsFromCompiler();
cases.push({
  name: 'compiler reserved vocabulary',
  source: reserved.join('; '),
  tokens: reserved.map((text) => [text, ['true', 'false', 'nil'].includes(text) ? 'constant' : 'keyword']),
}, {
  name: 'all reserved words can be escaped identifiers',
  source: reserved.map((text) => `$${text}`).join(' '),
  tokens: reserved.map((text) => [`$${text}`, 'identifier']),
});

describe('shared lexical parity cases through the TextMate engine', () => {
  let registry: Registry;
  beforeAll(async () => {
    const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
    await loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
    registry = new Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (patterns) => new OnigScanner(patterns),
        createOnigString: (text) => new OnigString(text),
      }),
      loadGrammar: async () => parseRawGrammar(fs.readFileSync(grammarPath, 'utf8'), grammarPath),
    });
  });
  afterAll(() => registry?.dispose());

  it('recognizes the same Markdown fence aliases as Prism', () => {
    const injection = JSON.parse(fs.readFileSync(injectionPath, 'utf8'));
    const scanner = new OnigScanner([injection.repository['gsharp-code-block'].begin]);
    try {
      for (const alias of ['gs', 'gsharp', 'g#', 'GS', 'GSharp', 'G#']) {
        expect(scanner.findNextMatchSync(`\`\`\`${alias}`, 0)).not.toBeNull();
      }
      expect(scanner.findNextMatchSync('```gsharpish', 0)).toBeNull();
    } finally {
      scanner.dispose();
    }
  });

  it.each(cases)('$name', async ({source, tokens, absent = [], format}) => {
    const loaded = (await registry.loadGrammar('source.gsharp'))!;
    let stack = INITIAL;
    const scopes: string[][] = [];
    const lines = source.split(/(\r\n|\r|\n)/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 2) {
      const line = lines[lineIndex];
      const result = loaded.tokenizeLine(line, stack);
      for (const token of result.tokens) {
        for (let i = token.startIndex; i < Math.min(token.endIndex, line.length); i++) {
          scopes.push(token.scopes);
        }
      }
      for (let i = 0; i < (lines[lineIndex + 1]?.length ?? 0); i++) scopes.push([]);
      stack = result.ruleStack;
    }
    const categories: Record<string, RegExp> = {
      keyword: /^keyword\./, identifier: /^(variable\.other|entity\.name)/,
      type: /^(support\.type|entity\.name\.type)/, function: /^entity\.name\.function/,
      number: /^constant\.numeric/, operator: /^(keyword\.operator|meta\.conditional)/,
      string: /^string\./, char: /^string\.quoted\.single/, format: /^string\.unquoted\.format/,
      interpolation: /^(meta\.interpolation|variable\.other\.interpolation|punctuation\.definition\.interpolation)/,
      escape: /^constant\.character\.escape/, annotation: /^storage\.type\.annotation/,
      constant: /^constant\.language/, comment: /^comment\./,
    };
    for (const [text, kind] of tokens) {
      const start = source.indexOf(text);
      expect(start).toBeGreaterThanOrEqual(0);
      for (let i = start; i < start + text.length; i++) {
        expect({text, char: source[i], scopes: scopes[i],
          covered: scopes[i].some((scope) => categories[kind].test(scope))})
          .toEqual(expect.objectContaining({covered: true}));
      }
    }
    for (const [text, kind] of absent) {
      const start = source.indexOf(text);
      expect(start).toBeGreaterThanOrEqual(0);
      for (let i = start; i < start + text.length; i++) {
        expect(scopes[i].some((scope) => categories[kind].test(scope))).toBe(false);
      }
    }
    if (format !== undefined) {
      const start = source.lastIndexOf(format);
      expect(start).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < source.length; i++) {
        if (scopes[i].some((scope) => categories.format.test(scope))) {
          expect(i >= start && i < start + format.length).toBe(true);
        }
      }
    }
  });
});

function reservedKeywordsFromCompiler(): string[] {
  const source = fs.readFileSync(syntaxFactsPath, 'utf8');
  // Inside SyntaxFacts.GetKeywordKind every reserved keyword appears as a
  // `case "word" {` label; it is the only switch in the file keyed by string.
  const matches = source.matchAll(/case\s+"([a-zA-Z]+)"\s*\{/g);
  return Array.from(matches, (m) => m[1]).sort();
}

function repositoryMatchStrings(section: string): string[] {
  const patterns = grammar.repository[section]?.patterns ?? [];
  return patterns
    .map((p: {match?: string}) => p.match)
    .filter((m: string | undefined): m is string => typeof m === 'string');
}

describe('gsharp.tmLanguage.json', () => {
  it('keeps UTF-8 strings adjacent, text-escaped and non-interpolating', () => {
    const utf8 = grammar.repository['utf8-string'];
    const prefix = new RegExp(utf8.begin);
    expect(prefix.exec('u8"$name${unclosed"')?.index).toBe(0);
    for (const spelling of ['au8"x"', '$u8"x"', 'U8"x"', 'u8 "x"']) {
      expect(prefix.test(spelling)).toBe(false);
    }
    expect(utf8.patterns).toEqual([{include: '#string-escape'}]);
    const escape = new RegExp(grammar.repository['string-escape'].patterns[0].match);
    expect(escape.exec('\\xF')?.[0]).toBe('\\xF');
    expect(escape.exec('\\xFFFF0')?.[0]).toBe('\\xFFFF');
    expect(escape.exec('\\U0001F600')?.[0]).toBe('\\U0001F600');
  });

  it('keeps byte strings non-interpolating with an adjacent unescaped prefix', () => {
    const bytes = grammar.repository['byte-string'];
    const prefix = new RegExp(bytes.begin);
    expect(prefix.exec('b"$name${literal}"')?.index).toBe(0);
    expect(prefix.test('ab"x"')).toBe(false);
    expect(prefix.test('$b"x"')).toBe(false);
    expect(prefix.test('b "x"')).toBe(false);
    expect(bytes.patterns.some((p: {include?: string}) =>
      p.include?.startsWith('#interpolation'))).toBe(false);
    const escape = new RegExp(bytes.patterns[0].match);
    expect(escape.exec('\\xFF')?.[0]).toBe('\\xFF');
    expect(escape.test('\\xF')).toBe(false);
    expect(escape.test('\\a')).toBe(false);
    expect(escape.exec('\\x000')?.[0]).toBe('\\x00');
  });

  it('is well-formed JSON with the expected scope name', () => {
    expect(grammar.scopeName).toBe('source.gsharp');
    const injection = JSON.parse(fs.readFileSync(injectionPath, 'utf8'));
    expect(injection.scopeName).toBe('markdown.gsharp.codeblock');
  });

  it('highlights every reserved keyword the compiler recognises', () => {
    const reserved = reservedKeywordsFromCompiler();
    // Sanity: the parse found a plausible keyword set.
    expect(reserved).toContain('protected');
    expect(reserved).toContain('func');
    expect(reserved.length).toBeGreaterThan(40);

    const matchers = [
      ...repositoryMatchStrings('keywords'),
      ...repositoryMatchStrings('constants'),
    ].map((m) => new RegExp(m));

    const uncovered = reserved.filter(
      (kw) => !matchers.some((r) => r.test(kw)),
    );
    expect(uncovered).toEqual([]);
  });

  it('covers compiler contextual keywords', () => {
    const contextual = repositoryMatchStrings('keywords').map(
      (m) => new RegExp(m),
    );
    const required = [
      'unsafe',
      'fixed',
      'stackalloc',
      'unmanaged',
      'init',
      'params',
      'explicit',
      'implicit',
      'and',
      'or',
      'not',
      'scoped',
      'ref',
      'partial',
      'abstract',
      'shared',
      'sizeof',
    ];
    const missing = required.filter(
      (kw) => !contextual.some((r) => r.test(kw)),
    );
    expect(missing).toEqual([]);
  });

  it('does not treat `where` as a keyword (G# uses bracketed constraints)', () => {
    const matchers = [
      ...repositoryMatchStrings('keywords'),
      ...repositoryMatchStrings('declarations'),
    ].map((m) => new RegExp(m));
    expect(matchers.some((r) => r.test('where'))).toBe(false);
  });

  it('does not treat the removed `null` alias as a literal', () => {
    const constantMatchers = repositoryMatchStrings('constants').map(
      (m) => new RegExp(m),
    );
    expect(constantMatchers.some((r) => r.test('null'))).toBe(false);
  });

  it('does not treat `extension` as a contextual keyword (ADR-0182 retired the marker)', () => {
    // ADR-0165's explicit-extension-receiver marker `extension` (issue
    // #3357) was retired by ADR-0182 (issue #4240): every receiver clause
    // is unconditionally an extension now, so `extension` is an ordinary
    // identifier again — it must not highlight as a keyword, the same way
    // the website Prism grammar's `contextualKeywords` regex excludes it.
    const matchers = [
      ...repositoryMatchStrings('keywords'),
      ...repositoryMatchStrings('declarations'),
    ].map((m) => new RegExp(m));
    expect(matchers.some((r) => r.test('extension'))).toBe(false);
  });

  it('recognizes assembly-target annotations', () => {
    const annotationMatchers = repositoryMatchStrings('annotations').map(
      (m) => new RegExp(m, 'u'),
    );
    expect(
      annotationMatchers.some((r) =>
        r.test('@assembly:InternalsVisibleTo'),
      ),
    ).toBe(true);
  });

  it('recognizes anonymous-object and explicit-interface declaration forms', () => {
    const keywordMatchers = repositoryMatchStrings('keywords').map(
      (m) => new RegExp(m),
    );
    expect(keywordMatchers.some((r) => r.test('object {'))).toBe(true);
    expect(keywordMatchers.some((r) => r.test('object : IFoo {'))).toBe(true);

    const declarationMatchers = repositoryMatchStrings('declarations').map(
      (m) => new RegExp(m, 'u'),
    );
    const declarations = [
      'func (IFoo) M()',
      'prop (IFoo) P int32',
      'prop (IFoo) this[index int32] string',
      'event (IFoo) Changed Handler',
    ];
    const missing = declarations.filter(
      (declaration) => !declarationMatchers.some((r) => r.test(declaration)),
    );
    expect(missing).toEqual([]);
  });

  describe('canonical delegate declarations', () => {
    const declarationPatterns: {
      match?: string;
      captures?: Record<string, {name?: string}>;
    }[] = grammar.repository.declarations.patterns;

    const cases: [string, string][] = [
      ['delegate Greeter(name string) string', 'Greeter'],
      ['delegate Mapper[T any](value T) T', 'Mapper'],
    ];

    it.each(cases)('captures the type name in `%s`', (source, name) => {
      const pattern = declarationPatterns.find(
        (p) => p.match && new RegExp(p.match, 'u').test(source),
      );
      expect(pattern).toBeDefined();
      const match = new RegExp(pattern!.match!, 'u').exec(source)!;
      expect(match[2]).toBe(name);
      expect(pattern!.captures?.['2']?.name).toBe('entity.name.type.gsharp');
    });
  });

  it('keeps ternary colons in interpolation expressions', () => {
    const patterns = grammar.repository['interpolation-braced'].patterns.map(
      (p: {include?: string}) => p.include,
    );
    expect(patterns.indexOf('#interpolation-conditional')).toBeLessThan(
      patterns.indexOf('#interpolation-format'),
    );

    const conditional = grammar.repository['interpolation-conditional'];
    const beginsConditional = new RegExp(conditional.begin);
    expect('ok ? 1 : 2'.search(beginsConditional)).toBe(3);
    expect(beginsConditional.test('a ?? b:D4')).toBe(false);
    expect(beginsConditional.test('a ?. b')).toBe(false);
    expect(beginsConditional.test('a ?[0]')).toBe(false);
    expect('a ? b : c ? d : e'.search(beginsConditional)).toBe(2);
    expect(conditional.end).toBe(':');
  });

  it('highlights all built-in primitive type names', () => {
    const typeMatchers = repositoryMatchStrings('types').map(
      (m) => new RegExp(m),
    );
    const primitives = [
      'bool',
      'uint8',
      'int8',
      'int16',
      'uint16',
      'int32',
      'uint32',
      'int64',
      'uint64',
      'nint',
      'nuint',
      'float32',
      'float64',
      'decimal',
      'char',
      'string',
      'object',
      'void',
      // friendly aliases accepted by the binder
      'byte',
      'sbyte',
      'short',
      'ushort',
      'int',
      'uint',
      'long',
      'ulong',
      'float',
      'double',
    ];
    const missing = primitives.filter(
      (t) => !typeMatchers.some((r) => r.test(t)),
    );
    expect(missing).toEqual([]);
  });

  describe('operator tokenization', () => {
    const operatorPatterns: {name: string; match: string}[] =
      grammar.repository.operators.patterns;

    // Emulates the TextMate engine for a single, isolated operator token:
    // the first pattern (in array order) that matches at index 0 wins. The
    // matched text must consume the whole operator — this guards the
    // longest-match-first ordering so e.g. `->` is not split into `-` + `>`.
    function tokenize(op: string): {name: string; text: string} | null {
      for (const p of operatorPatterns) {
        const m = new RegExp(p.match).exec(op);
        if (m && m.index === 0) {
          return {name: p.name, text: m[0]};
        }
      }
      return null;
    }

    const cases: [string, string][] = [
      ['..', 'keyword.operator.range.gsharp'],
      ['...', 'keyword.operator.spread.gsharp'],
      ['->', 'keyword.operator.arrow.gsharp'],
      ['=>', 'keyword.operator.arrow.gsharp'],
      ['<-', 'keyword.operator.channel.gsharp'],
      ['++', 'keyword.operator.increment.gsharp'],
      ['--', 'keyword.operator.increment.gsharp'],
      ['&^', 'keyword.operator.bitwise.gsharp'],
      ['&^=', 'keyword.operator.bitwise.gsharp'],
      ['!!', 'keyword.operator.null-forgiving.gsharp'],
      ['??', 'keyword.operator.null-coalescing.gsharp'],
      ['??=', 'keyword.operator.null-coalescing.gsharp'],
      ['?.', 'keyword.operator.null-conditional.gsharp'],
      ['?[', 'keyword.operator.null-conditional.gsharp'],
      [':=', 'keyword.operator.assignment.gsharp'],
      ['<<=', 'keyword.operator.assignment.gsharp'],
      ['>>>=', 'keyword.operator.assignment.gsharp'],
      ['>>=', 'keyword.operator.assignment.gsharp'],
      ['<<', 'keyword.operator.bitwise.gsharp'],
      ['>>>', 'keyword.operator.bitwise.gsharp'],
      ['>>', 'keyword.operator.bitwise.gsharp'],
    ];

    it.each(cases)('tokenizes %s as a single operator', (op, scope) => {
      const result = tokenize(op);
      expect(result).not.toBeNull();
      expect(result!.text).toBe(op);
      expect(result!.name).toBe(scope);
    });
  });
});
