import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Prism} from 'prism-react-renderer';

const site = fileURLToPath(new URL('../', import.meta.url));
const release = JSON.parse(readFileSync(path.join(site, 'src/data/release.json'), 'utf8'));
const versions = JSON.parse(readFileSync(path.join(site, 'versions.json'), 'utf8'));
function documents(directory) {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    return statSync(file).isDirectory() ? documents(file) : /\.mdx?$/.test(name) ? [file] : [];
  });
}

function registerGrammar() {
  const source = readFileSync(path.join(site, 'src/theme/prism-include-languages.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, esModuleInterop: true},
  }).outputText;
  const module = {exports: {}};
  runInNewContext(compiled, {
    module,
    exports: module.exports,
    require(name) {
      assert.equal(name, '@generated/docusaurus.config');
      return {themeConfig: {prism: {additionalLanguages: []}}};
    },
  });
  module.exports.default(Prism);
}

const grammarCases = JSON.parse(readFileSync(path.join(site,
  '../src/vscode-gsharp/src/test/grammar-cases.json'), 'utf8'));
const syntaxFacts = readFileSync(path.join(site,
  '../src/Core/CodeAnalysis/Syntax/SyntaxFacts.gs'), 'utf8');
const reserved = [...syntaxFacts.matchAll(/case\s+"([a-zA-Z]+)"\s*\{/g)].map((match) => match[1]).sort();
assert.ok(reserved.length > 40);
grammarCases.push({
  name: 'compiler reserved vocabulary',
  source: reserved.join('; '),
  tokens: reserved.map((text) => [text, ['true', 'false', 'nil'].includes(text) ? 'constant' : 'keyword']),
}, {
  name: 'all reserved words can be escaped identifiers',
  source: reserved.map((text) => `$${text}`).join(' '),
  tokens: reserved.map((text) => [`$${text}`, 'identifier']),
});
for (const {name, source, tokens, absent = [], format} of grammarCases) {
  test(`Prism lexical parity: ${name}`, () => {
    registerGrammar();
    const categories = {
      keyword: ['keyword'], identifier: ['identifier', 'function', 'class-name'],
      type: ['builtin', 'class-name'], function: ['function'], number: ['number'],
      operator: ['operator'], string: ['string', 'raw-string', 'byte-string'], format: ['format'],
      char: ['char'], interpolation: ['interpolation'], escape: ['char', 'string-escape', 'dollar-escape', 'byte-escape'],
      annotation: ['attr-name'], constant: ['constant', 'boolean'], comment: ['comment'],
    };
    const scopes = [];
    function flatten(items, parents = []) {
      for (const token of items) {
        if (typeof token === 'string') {
          for (let i = 0; i < token.length; i++) scopes.push(parents);
        } else {
          const kinds = [...parents, token.type, ...[token.alias ?? []].flat()];
          flatten(Array.isArray(token.content) ? token.content : [token.content], kinds);
        }
      }
    }
    flatten(Prism.tokenize(source, Prism.languages.gsharp));
    for (const [text, kind] of tokens) {
      const start = source.indexOf(text);
      assert.ok(start >= 0, `${name}: fixture contains ${text}`);
      for (let i = start; i < start + text.length; i++) {
        assert.ok(scopes[i].some((scope) => categories[kind].includes(scope)),
          `${name}: ${text} at ${i}: ${scopes[i]}`);
      }
    }
    for (const [text, kind] of absent) {
      const start = source.indexOf(text);
      assert.ok(start >= 0, `${name}: fixture contains ${text}`);
      for (let i = start; i < start + text.length; i++) {
        assert.ok(!scopes[i].some((scope) => categories[kind].includes(scope)),
          `${name}: ${text} at ${i} must not be ${kind}: ${scopes[i]}`);
      }
    }
    if (format !== undefined) {
      const start = source.lastIndexOf(format);
      assert.ok(start >= 0, `${name}: fixture contains ${format}`);
      for (let i = 0; i < source.length; i++) {
        if (scopes[i].includes('format')) {
          assert.ok(i >= start && i < start + format.length,
            `${name}: unexpected format scope at ${i}: ${scopes[i]}`);
        }
      }
    }
  });
}

test('Prism keeps exact byte literals distinct from CLR string interpolation', () => {
  registerGrammar();
  function types(tokens) {
    return tokens.flatMap((token) => typeof token === 'string'
      ? [] : [token.type, ...(Array.isArray(token.content) ? types(token.content) : [])]);
  }
  for (const input of ['b"$name${literal}"', 'b"${"', 'b"\\xFF\\0"']) {
    const actual = types(Prism.tokenize(input, Prism.languages.gsharp));
    assert.ok(actual.includes('byte-string'), input);
    assert.ok(!actual.includes('interpolation'), input);
  }
  for (const input of ['ab"x"', '$b"x"', 'b "x"', 'éb"x"']) {
    assert.ok(!types(Prism.tokenize(input, Prism.languages.gsharp)).includes('byte-string'), input);
  }
  assert.ok(types(Prism.tokenize('"${name}"', Prism.languages.gsharp)).includes('interpolation'));
});

test('Prism distinguishes function parameter modifiers from singleton named tuples', () => {
  registerGrammar();
  for (const modifier of ['ref', 'out', 'in']) {
    const valid = `"${'${'}value as ((${modifier} int32) -> void)? ?? fallback:G}"`;
    assert.match(Prism.highlight(valid, Prism.languages.gsharp, 'gsharp'), /class="token format\b/);
  }
  for (const name of ['element', 'ref', 'out', 'in']) {
    const invalid = `"${'${'}value as (${name} int32)? ?? fallback:G}"`;
    assert.doesNotMatch(Prism.highlight(invalid, Prism.languages.gsharp, 'gsharp'), /class="token format\b/);
  }
});

test('release metadata and installation stay aligned', () => {
  assert.equal(release.docsVersion, versions[0]);
  assert.equal(release.tag, `v${release.version}`);
  for (const directory of ['docs', `versioned_docs/version-${versions[0]}`]) {
    const install = readFileSync(path.join(site, directory, 'getting-started/install.md'), 'utf8');
    assert.ok(install.includes(`Gsharp.Templates::${release.version}`));
    assert.ok(install.includes(`Gsharp.NET.Sdk/${release.version}`));
  }
});

test('all current and released articles have intentional descriptions', () => {
  for (const directory of ['docs', `versioned_docs/version-${versions[0]}`]) {
    const files = documents(path.join(site, directory));
    assert.ok(files.length >= 47, `${directory}: non-vacuous inventory`);
    for (const file of files) {
      const frontMatter = readFileSync(file, 'utf8').split('---')[1];
      assert.match(frontMatter, /^description: ".+"/m, file);
    }
  }
});

test('ordinary documentation links retain their version', () => {
  for (const directory of [
    'docs',
    ...versions.map((version) => `versioned_docs/version-${version}`),
  ]) {
    for (const file of documents(path.join(site, directory))) {
      const prose = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
      assert.doesNotMatch(prose, /\]\(\/docs\/(?!next\/|0\.\d+\/)/, file);
    }
  }
});

test('current and released diagnostic catalogues contain one row per ID', () => {
  for (const directory of ['docs', `versioned_docs/version-${versions[0]}`]) {
    const source = readFileSync(path.join(site, directory, 'ref/diagnostics.md'), 'utf8');
    const ids = [...source.matchAll(/^\|\s*(GS\d{4})\s*\|/gm)].map((match) => match[1]);
    assert.ok(ids.length > 400, `${directory}: non-vacuous diagnostic inventory`);
    assert.equal(new Set(ids).size, ids.length, `${directory}: duplicate diagnostic rows`);
  }
});

test('active delegate documentation uses standalone declarations, not type aliases', () => {
  for (const directory of ['docs', `versioned_docs/version-${versions[0]}`]) {
    for (const page of ['guide/declarations-and-packages.md', 'guide/types-and-values.md']) {
      const source = readFileSync(path.join(site, directory, page), 'utf8');
      assert.ok(
        source.includes('standalone `delegate Name(parameters) ReturnType;`'),
        `${directory}/${page}: canonical declaration`,
      );
      assert.doesNotMatch(
        source,
        /type alias whose RHS is `delegate|Named-delegate declarations keep the `func`|aliases .* and named delegates|[.:];/,
        `${directory}/${page}: obsolete or malformed delegate guidance`,
      );
    }
    const spec = readFileSync(path.join(site, directory, 'ref/spec.md'), 'utf8');
    assert.match(spec, /DelegateDecl\s+= Visibility\? "delegate" identifier .* ";" \./);
    assert.match(spec, /DelegateDecl\s+::= 'delegate' identifier .* ';'/);
    assert.doesNotMatch(spec, /DelegateAliasDecl|DelegateAliasTail|alias and named-delegate forms/);
    const diagnostics = readFileSync(path.join(site, directory, 'ref/diagnostics.md'), 'utf8');
    const delegates = diagnostics
      .split('## Named delegate type diagnostics (GS0233)')[1]
      .split('\n## ')[0];
    assert.ok(delegates.includes('delegate Predicate[T any](value T) bool;'));
    assert.doesNotMatch(delegates, /right-hand side|type Predicate/);
    assert.doesNotMatch(diagnostics, /`delegate func\(\.\.\.\)` named-delegate declarations/);
  }
});

test('tutorial source and output match the canonical showcase fixture', () => {
  const checkedDocs = {
    WebsiteData: ['tutorials/getting-started.md'],
    WebsiteBindings: ['guide/effective-gsharp.md'],
    WebsiteKotlin: ['bridges/gsharp-for-kotlin-developers.md'],
    WebsiteSwift: ['bridges/gsharp-for-swift-developers.md'],
    WebsiteFallthrough: ['tour/control-flow.md'],
    WebsiteConcurrency: ['guide/concurrency.md', 'tour/concurrency.md', 'tutorials/concurrency.md'],
  };
  for (const directory of ['docs', `versioned_docs/version-${versions[0]}`]) {
    for (const [sample, pages] of Object.entries(checkedDocs)) {
      const source = readFileSync(path.join(site, `../samples/${sample}.gs`), 'utf8').trim();
      const output = readFileSync(path.join(site, `../samples/${sample}.golden`), 'utf8').trim();
      for (const page of pages) {
        const tutorial = readFileSync(path.join(site, directory, page), 'utf8');
        assert.ok(tutorial.includes(source), `${directory}/${page}: source must match ${sample}`);
        assert.ok(
          tutorial.includes(`\`\`\`text\n${output}\n\`\`\``),
          `${directory}/${page}: expected output`,
        );
      }
    }
  }
});

test('the ten-pattern comparison matches its executed bundle and benchmark source', () => {
  const examples = JSON.parse(
    readFileSync(path.join(site, 'src/data/concurrency-examples.json'), 'utf8'),
  );
  const checks = JSON.parse(
    readFileSync(path.join(site, 'static/data/concurrency-checks.json'), 'utf8'),
  );
  const measurements = JSON.parse(
    readFileSync(path.join(site, 'static/data/concurrency-bench.json'), 'utf8'),
  );
  assert.equal(examples.patterns.length, 10);
  assert.equal(new Set(examples.patterns.map((p) => p.id)).size, 10);
  assert.equal(checks.bundleSha256, examples.bundleSha256);
  assert.equal(checks.sdkVersion, release.version);
  for (const pattern of examples.patterns) {
    assert.ok(checks.patterns.some((entry) => entry.id === pattern.id && entry.passed));
    for (const name of pattern.benchmarks) {
      if (measurements.status === 'available')
        assert.ok(measurements.scenarios.some((row) => row.name === name));
    }
  }
  if (measurements.status === 'available') {
    assert.equal(measurements.source.commit.length, 40);
    assert.equal(measurements.measurement.wholeRuns, 3);
    for (const row of measurements.scenarios) {
      if (!row.goScenario) {
        assert.equal(row.go, null);
        assert.equal(row.jitOverGo, null);
        assert.equal(row.aotOverGo, null);
      }
    }
  } else {
    assert.ok(measurements.reason);
    assert.equal(measurements.scenarios.length, 0);
  }
});

test('active teaching pages do not recommend the retired concurrency gate', () => {
  for (const directory of ['docs', `versioned_docs/version-${versions[0]}`]) {
    for (const name of ['guide/effective-gsharp.md', 'tutorials/concurrency.md']) {
      const text = readFileSync(path.join(site, directory, name), 'utf8');
      assert.doesNotMatch(
        text,
        /which opt in with|is an opt-in\s+extension|is an\s+opt-in extension/,
      );
      assert.doesNotMatch(text, /let count int = 0/);
    }
  }
});

test('active control-flow documentation describes supported explicit fallthrough', () => {
  const pages = [
    'ref/spec.md',
    'ref/feature-matrix.md',
    'tour/control-flow.md',
    'tutorials/control-flow.md',
    'bridges/gsharp-for-go-developers.md',
    'guide/expressions-and-statements.md',
  ];
  for (const directory of ['docs', `versioned_docs/version-${versions[0]}`]) {
    for (const page of pages) {
      const text = readFileSync(path.join(site, directory, page), 'utf8');
      assert.doesNotMatch(
        text,
        /does not support fallthrough|fallthrough.{0,60}reserved.{0,80}(?:diagnostic|unsupported)|FallthroughStmt[^\n]*unsupported/i,
        `${directory}/${page}`,
      );
    }
    const matrix = readFileSync(path.join(site, directory, 'ref/feature-matrix.md'), 'utf8');
    assert.match(matrix, /\| `fallthrough` \| Supported \|/);
  }
});

test('Trail and its editor evidence match the advertised release and source', () => {
  const source = readFileSync(path.join(site, '../samples/Trail/Program.gs'));
  const project = readFileSync(path.join(site, '../samples/Trail/Trail.gsproj'), 'utf8');
  const capture = JSON.parse(readFileSync(path.join(site, 'static/img/trail-editor.json'), 'utf8'));
  assert.ok(project.includes(`Gsharp.NET.Sdk/${release.version}`));
  assert.equal(capture.applicationSdk, release.version);
  assert.equal(capture.sourceSha256, createHash('sha256').update(source).digest('hex'));
  for (const directory of ['docs', `versioned_docs/version-${versions[0]}`]) {
    const tutorial = readFileSync(path.join(site, directory, 'tutorials/trail.md'), 'utf8');
    assert.ok(tutorial.includes(`trail-${release.version}.zip`));
    for (const [, excerpt] of tutorial.matchAll(/```gsharp\n([\s\S]*?)\n```/g)) {
      const unindentedSource = source
        .toString()
        .split('\n')
        .map((line) => line.trim())
        .join('\n');
      const unindentedExcerpt = excerpt
        .split('\n')
        .map((line) => line.trim())
        .join('\n');
      assert.ok(unindentedSource.includes(unindentedExcerpt), `${directory}: Trail source excerpt`);
    }
  }
});

test('release refresh preserves legacy anchors at their replacement sections', () => {
  const anchors = {
    'design-decisions.md': ['04-adrs-0157-0165'],
    'extensions/go-builtins.md': [
      'length-and-capacity--len--cap',
      'append--append',
      'delete--delete',
    ],
    'ref/spec.md': ['go-style-built-ins-import-gsharpextensionsgo'],
    'ref/diagnostics.md': [
      'go-flavored-concurrency-requires-import-gsharpextensionsgo-gs0316',
      'go-style-built-ins-require-import-gsharpextensionsgo-gs0317',
    ],
    'ref/standard-library.md': ['intrinsic-functions-and-operations', 'gsharpextensionsgo'],
  };
  for (const [file, ids] of Object.entries(anchors)) {
    const source = readFileSync(path.join(site, 'versioned_docs/version-0.4', file), 'utf8');
    for (const id of ids) assert.ok(source.includes(`id="${id}"`), `${file}: ${id}`);
  }
});
