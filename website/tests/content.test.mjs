import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import test from 'node:test';
import {createHash} from 'node:crypto';

const site = fileURLToPath(new URL('../', import.meta.url));
const release = JSON.parse(readFileSync(path.join(site, 'src/data/release.json'), 'utf8'));
const versions = JSON.parse(readFileSync(path.join(site, 'versions.json'), 'utf8'));
function documents(directory) {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    return statSync(file).isDirectory() ? documents(file) : /\.mdx?$/.test(name) ? [file] : [];
  });
}

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

test('the ten-pattern comparison matches its executed bundle and workflow source', () => {
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
