import * as fs from 'fs';
import * as path from 'path';

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
  'src/Core/CodeAnalysis/Syntax/SyntaxFacts.cs',
);

const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8'));

function reservedKeywordsFromCompiler(): string[] {
  const source = fs.readFileSync(syntaxFactsPath, 'utf8');
  // Inside SyntaxFacts.GetKeywordKind every reserved keyword appears as a
  // `case "word":` label; it is the only switch in the file keyed by string.
  const matches = source.matchAll(/case\s+"([a-zA-Z]+)":/g);
  return Array.from(matches, (m) => m[1]).sort();
}

function repositoryMatchStrings(section: string): string[] {
  const patterns = grammar.repository[section]?.patterns ?? [];
  return patterns
    .map((p: {match?: string}) => p.match)
    .filter((m: string | undefined): m is string => typeof m === 'string');
}

describe('gsharp.tmLanguage.json', () => {
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

  it('covers the new 0.2 contextual keywords', () => {
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
      ['...', 'keyword.operator.range.gsharp'],
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
      ['>>=', 'keyword.operator.assignment.gsharp'],
      ['<<', 'keyword.operator.bitwise.gsharp'],
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
