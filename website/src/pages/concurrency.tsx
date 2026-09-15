import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import CodeBlock from '@theme/CodeBlock';
import examples from '@site/src/data/concurrency-examples.json';
import checks from '@site/static/data/concurrency-checks.json';
import ConcurrencyBenchmarks, {benchmarkSnapshot} from '@site/src/components/ConcurrencyBenchmarks';
import styles from './concurrency.module.css';

export default function Concurrency(): ReactNode {
  const download = useBaseUrl(examples.download);
  const verified =
    checks.bundleSha256 === examples.bundleSha256 &&
    checks.sdkVersion === examples.sdkVersion &&
    examples.patterns.every((p) => checks.patterns.some((c) => c.id === p.id && c.passed));
  return (
    <Layout
      title="Ten concurrency patterns: Go and G#"
      description="Compare ten runnable Go and G# concurrency patterns by correctness, cancellation, ownership, and ease of use, with separately sourced workflow measurements.">
      <main className={styles.page} data-pagefind-body data-pagefind-filter="version:general">
        <header className={styles.hero}>
          <div className="gs-container">
            <p className="gs-eyebrow">Go / G# / Evidence before a verdict</p>
            <Heading as="h1">
              Ten patterns.
              <br />
              Two runtimes.
            </Heading>
            <p>
              Compare the code, check its contract, and then look at the measurements. Similar
              syntax is not a substitute for correct lifetime and error behavior.
            </p>
            <div className="gs-actions">
              <a className="gs-button gs-button-brand" href={download} download>
                Download all ten pairs
              </a>
              <Link className="gs-button gs-button-ghost" to="#benchmark-heading">
                Inspect workflow measurements
              </Link>
            </div>
            <p className={styles.version}>
              Examples: G# SDK {examples.sdkVersion}, Go {examples.goVersion} or compatible newer
              Go. No extra Go modules.
            </p>
          </div>
        </header>
        <div className="gs-container">
          <section className={styles.intro}>
            <Heading as="h2">Three questions, kept separate.</Heading>
            <div className={styles.questions}>
              <div>
                <Heading as="h3">Is it correct?</Heading>
                <p>
                  Check delivery, closure, cancellation, failure propagation, shared state, and
                  cleanup for the stated workload.
                </p>
              </div>
              <div>
                <Heading as="h3">Is it clear?</Heading>
                <p>
                  Compare ownership and bookkeeping, not just line counts. Familiarity and library
                  choices influence the result.
                </p>
              </div>
              <div>
                <Heading as="h3">What was measured?</Heading>
                <p>
                  The workflow measures lower-level operations, not these teaching programs. Some
                  patterns have no relevant measurement.
                </p>
              </div>
            </div>
            <div className="gs-comparison-notice">
              <strong>Do not mix the two evidence sets.</strong>
              <p>
                The examples use published SDK {examples.sdkVersion}. The benchmark snapshot{' '}
                {benchmarkSnapshot.source ? (
                  <>
                    uses compiler {benchmarkSnapshot.source.compilerVersion} at commit{' '}
                    <code>{benchmarkSnapshot.source.commit.slice(0, 12)}</code>
                  </>
                ) : (
                  <>is unavailable</>
                )}
                . Its numbers do not establish the performance of the example SDK.
              </p>
            </div>
            {verified ? (
              <p className={styles.verification}>
                Matching-source checks recorded at <time>{checks.checkedAt}</time>: every pair run{' '}
                {checks.patterns[0].repetitions} times; {checks.goVersion}; .NET SDK{' '}
                {checks.dotnetSdk}.{' '}
                {checks.goRaceDetector
                  ? 'The Go runs also used the race detector.'
                  : 'These recorded Go runs did not use the race detector.'}{' '}
                G# has executable contract checks here, not an equivalent dynamic race-detector
                result.
              </p>
            ) : (
              <p role="alert">
                The source bundle does not match the recorded verification. Run the verifier before
                treating these examples as checked.
              </p>
            )}
            <nav aria-label="The ten concurrency patterns">
              <ol className={styles.index}>
                {examples.patterns.map((p) => (
                  <li key={p.id}>
                    <Link to={`#pattern-${p.id}`}>{p.title}</Link>
                  </li>
                ))}
              </ol>
            </nav>
          </section>
          {examples.patterns.map((pattern, index) => (
            <section
              className={styles.pattern}
              key={pattern.id}
              aria-labelledby={`pattern-${pattern.id}`}>
              <p className="gs-eyebrow">Pattern {String(index + 1).padStart(2, '0')}</p>
              <Heading as="h2" id={`pattern-${pattern.id}`}>
                {pattern.title}
              </Heading>
              <p className={styles.contract}>{pattern.contract}</p>
              <dl className={styles.assessment}>
                <div>
                  <dt>Checked cases</dt>
                  <dd>{pattern.checks}</dd>
                </div>
                <div>
                  <dt>G# choices</dt>
                  <dd>{pattern.gsharpNotes}</dd>
                </div>
                <div>
                  <dt>Go choices</dt>
                  <dd>{pattern.goNotes}</dd>
                </div>
                <div>
                  <dt>Boundaries</dt>
                  <dd>{pattern.limits}</dd>
                </div>
              </dl>
              <details className={styles.code}>
                <summary>Compare the Go and G# implementations</summary>
                <p>
                  These pattern files share only the dispatcher/assertion helper shown below. The
                  download contains complete projects, not isolated snippets.
                </p>
                <div className={styles.codePair}>
                  <CodeBlock language="go" title={pattern.goFile}>
                    {pattern.go}
                  </CodeBlock>
                  <CodeBlock language="gsharp" title={pattern.gsharpFile}>
                    {pattern.gsharp}
                  </CodeBlock>
                </div>
                <CodeBlock language="text" title="Expected summary from either implementation">
                  {pattern.output}
                </CodeBlock>
              </details>
              <p className={styles.related}>
                <strong>Whole-pattern performance: not measured.</strong>
                {benchmarkSnapshot.status !== 'available' ? (
                  <> No workflow snapshot is available.</>
                ) : pattern.benchmarks.length > 0 ? (
                  <>
                    {' '}
                    Related lower-level operations:{' '}
                    {pattern.benchmarks.map((name, i) => (
                      <span key={name}>
                        {i > 0 ? ', ' : ''}
                        <Link to={`#benchmark-${name}`}>{name}</Link>
                      </span>
                    ))}
                    . These links are context, not a timing of this pattern.
                  </>
                ) : (
                  <>
                    {' '}
                    The current registry has no matching cache, limiter, timer-wrapper, or
                    atomic/lazy workload for this example.
                  </>
                )}
              </p>
            </section>
          ))}
          <section className={styles.run} aria-labelledby="run-patterns">
            <Heading as="h2" id="run-patterns">
              Run the checks yourself.
            </Heading>
            <p>
              Unzip the bundle and choose a pattern ID from the index. A failed invariant produces a
              nonzero process exit. The checks demonstrate the listed cases, not a formal proof or a
              production-ready framework.
            </p>
            <div className={styles.codePair}>
              <CodeBlock language="bash" title="From the extracted ConcurrencyPatterns folder">
                {'dotnet run --project gsharp -- worker-pool'}
              </CodeBlock>
              <CodeBlock language="bash" title="Go">
                {'cd go\ngo run . worker-pool'}
              </CodeBlock>
            </div>
            <p>
              From a clone of this repository, run{' '}
              <code>python3 website/tests/verify-concurrency-patterns.py --race</code>. The verifier
              uses the downloadable bundle, compares all ten summaries, repeats each pair, and
              checks that both compilers reject a receive-only send. A supported Go/C toolchain is
              required for the race detector.
            </p>
            <details>
              <summary>Shared runner and assertion helper</summary>
              <div className={styles.codePair}>
                <CodeBlock language="go" title="main.go">
                  {examples.goRunner}
                </CodeBlock>
                <CodeBlock language="gsharp" title="Program.gs">
                  {examples.gsharpRunner}
                </CodeBlock>
              </div>
            </details>
          </section>
          <ConcurrencyBenchmarks />
          <section className={styles.next}>
            <Heading as="h2">Choose the contract before the syntax.</Heading>
            <p>
              Go offers a familiar channel/context ecosystem and a mature race detector. G# combines
              language-level channels and scopes with .NET libraries, exceptions, and tooling.
              Neither removes the need to define ownership, synchronization, or cancellation
              boundaries.
            </p>
            <div className="gs-actions">
              <Link
                className="gs-button gs-button-outline"
                to="/docs/bridges/gsharp-for-go-developers">
                G# for Go developers
              </Link>
              <Link className="gs-text-link" to="/docs/bridges/gsharp-for-swift-developers">
                Coming from Swift? <span aria-hidden="true">&rarr;</span>
              </Link>
            </div>
          </section>
        </div>
      </main>
    </Layout>
  );
}
