import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import CodeBlock from '@theme/CodeBlock';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import InstallCommands from '@site/src/components/InstallCommands';
import {examples, languageExamples} from '@site/src/data/examples';
import EditorProof from '@site/src/components/EditorProof';
import release from '@site/src/data/release.json';
import styles from './index.module.css';

export default function Home(): ReactNode {
  const artwork = useBaseUrl('/img/ember-facets.svg');
  return (
    <Layout
      title="A fresh way to build on .NET"
      description="Meet G#: expressive data types, explicit nullability, and structured concurrency on .NET. Explore real examples and run your first project.">
      <main className={styles.home} data-pagefind-body data-pagefind-filter="version:general">
        <header className={styles.hero}>
          <img
            className={styles.artwork}
            src={artwork}
            alt=""
            aria-hidden="true"
            width="800"
            height="800"
          />
          <div className="gs-container">
            <Link className={styles.release} to="/docs/release-notes">
              G# {release.version} <span aria-hidden="true">/</span> See what&apos;s new{' '}
              <span aria-hidden="true">&rarr;</span>
            </Link>
            <div className={styles.heroGrid}>
              <div>
                <p className="gs-eyebrow">Different syntax. Familiar ground.</p>
                <Heading as="h1">
                  A fresh way to
                  <br className={styles.desktopBreak} /> build on <span>.NET.</span>
                </Heading>
                <p className={styles.lede}>
                  Expressive code. Explicit nullability. Concurrency with structure. All on the
                  runtime you already know.
                </p>
                <div className="gs-actions">
                  <Link className="gs-button gs-button-brand" to="/docs/getting-started/install">
                    Get started <span aria-hidden="true">&rarr;</span>
                  </Link>
                  <Link className="gs-button gs-button-ghost" to="/docs/tour">
                    Take the tour
                  </Link>
                </div>
                <p className={styles.heroNote}>Open source. Built for .NET. Yours to explore.</p>
              </div>
              <div className={styles.heroCode}>
                <div className={styles.codeCaption}>
                  <span className={styles.codeDot} /> A little G# goes a long way.
                </div>
                <CodeBlock language="gsharp" title="point.gs">
                  {examples.data.source}
                </CodeBlock>
                <div className={styles.output}>
                  <span>Expected output</span>
                  <pre>{examples.data.output}</pre>
                </div>
              </div>
            </div>
            <div className={styles.heroFoot}>
              <span>
                Write <strong>.gs</strong>
              </span>
              <span>
                Build with <strong>dotnet</strong>
              </span>
              <span>
                Use <strong>.NET libraries</strong>
              </span>
            </div>
          </div>
        </header>

        <section className="gs-section" aria-labelledby="start-heading">
          <div className={`gs-container ${styles.installGrid}`}>
            <div>
              <p className="gs-eyebrow">From curious to compiling</p>
              <Heading as="h2" id="start-heading">
                Your first G# project.
                <br />
                Your usual terminal.
              </Heading>
              <p>
                Install the {release.sdk}, then create a console app. No new build system to learn.
              </p>
              <Link className="gs-text-link" to="/docs/getting-started/install">
                Installation and prerequisites <span aria-hidden="true">&rarr;</span>
              </Link>
              <p className="gs-small">Commands use the published {release.version} release.</p>
            </div>
            <InstallCommands />
          </div>
        </section>

        <section className={`gs-section ${styles.language}`} aria-labelledby="language-heading">
          <div className="gs-container">
            <div className={styles.sectionIntro}>
              <p className="gs-eyebrow">The language, in practice</p>
              <Heading as="h2" id="language-heading">
                Less ceremony.
                <br />
                More of what you mean.
              </Heading>
              <p>
                Ideas from Go, Kotlin, and Swift, shaped for .NET. See what that looks like in code.
              </p>
            </div>
            <Tabs groupId="homepage-examples" queryString="example" defaultValue="concurrency">
              {languageExamples.map((example) => (
                <TabItem key={example.id} value={example.id} label={example.label}>
                  <div className={styles.exampleGrid}>
                    <div className={styles.exampleText}>
                      <Heading as="h3">{example.title}</Heading>
                      <p>{example.description}</p>
                      <Link className="gs-text-link" to={example.to}>
                        {example.link} <span aria-hidden="true">&rarr;</span>
                      </Link>
                      <p className="gs-small">
                        Complete source. Verified output. No simulated execution.
                      </p>
                    </div>
                    <div className={styles.exampleCode}>
                      <CodeBlock language="gsharp" title={example.file}>
                        {example.source}
                      </CodeBlock>
                      <div className={styles.exampleOutput}>
                        <span>Expected output</span>
                        <pre>{example.output}</pre>
                      </div>
                    </div>
                  </div>
                </TabItem>
              ))}
            </Tabs>
          </div>
        </section>

        <section className="gs-section" aria-labelledby="workflow-heading">
          <div className={`gs-container ${styles.workflowGrid}`}>
            <EditorProof />
            <div>
              <p className="gs-eyebrow">Build something real</p>
              <Heading as="h2" id="workflow-heading">
                A useful project.
                <br />
                Your familiar editor.
              </Heading>
              <p>
                Trail turns local files into a JSON inventory using data classes, nullable filters,
                channels, and a bounded worker pool. Inspect real .NET APIs in your editor, then run
                the complete project with the published SDK.
              </p>
              <div className="gs-actions">
                <Link className="gs-button gs-button-outline" to="/trail">
                  Explore Trail
                </Link>
                <Link className="gs-text-link" to="/docs/tutorials/trail">
                  Build it step by step <span aria-hidden="true">&rarr;</span>
                </Link>
              </div>
            </div>
          </div>
        </section>

        <section className={`gs-section ${styles.paths}`} aria-labelledby="paths-heading">
          <div className="gs-container">
            <p className="gs-eyebrow">Find your starting point</p>
            <Heading as="h2" id="paths-heading">
              Bring what you know.
            </Heading>
            <div className={`gs-card-grid ${styles.audienceGrid}`}>
              <Link className="gs-card" to="/docs/tour">
                <span className="gs-card-number">01 / Discover</span>
                <Heading as="h3">New to G#?</Heading>
                <p>
                  Start with small, complete programs. Get a feel for the language one idea at a
                  time.
                </p>
                <span className="gs-text-link">
                  Take the tour <span aria-hidden="true">&rarr;</span>
                </span>
              </Link>
              <Link className="gs-card" to="/docs/bridges/gsharp-for-csharp-developers">
                <span className="gs-card-number">02 / Connect</span>
                <Heading as="h3">Coming from C#?</Heading>
                <p>
                  Keep your .NET knowledge. Learn the syntax, data shapes, and conventions that
                  differ.
                </p>
                <span className="gs-text-link">
                  The C# developer&apos;s guide <span aria-hidden="true">&rarr;</span>
                </span>
              </Link>
              <Link className="gs-card" to="/docs/bridges/gsharp-for-go-developers">
                <span className="gs-card-number">03 / Translate</span>
                <Heading as="h3">Coming from Go?</Heading>
                <p>
                  Recognize packages and channels. Get oriented to nullable types, exceptions, and
                  the CLR.
                </p>
                <span className="gs-text-link">
                  The Go developer&apos;s guide <span aria-hidden="true">&rarr;</span>
                </span>
              </Link>
              <Link className="gs-card" to="/docs/bridges/gsharp-for-kotlin-developers">
                <span className="gs-card-number">04 / Reframe</span>
                <Heading as="h3">Coming from Kotlin?</Heading>
                <p>
                  Bring your data-class and nullable-flow intuition. Learn the .NET runtime and the
                  differences that matter.
                </p>
                <span className="gs-text-link">
                  The Kotlin developer&apos;s guide <span aria-hidden="true">&rarr;</span>
                </span>
              </Link>
              <Link className="gs-card" to="/docs/bridges/gsharp-for-swift-developers">
                <span className="gs-card-number">05 / Connect runtimes</span>
                <Heading as="h3">Coming from Swift?</Heading>
                <p>
                  Start with familiar optionals and value types. Learn where .NET lifetime,
                  libraries, and concurrency differ.
                </p>
                <span className="gs-text-link">
                  The Swift developer&apos;s guide <span aria-hidden="true">&rarr;</span>
                </span>
              </Link>
            </div>
          </div>
        </section>

        <section className="gs-section" aria-labelledby="project-heading">
          <div className={`gs-container ${styles.projectGrid}`}>
            <div>
              <p className="gs-eyebrow">Open by design</p>
              <Heading as="h2" id="project-heading">
                A work in progress.
                <br />
                Not a black box.
              </Heading>
              <p>
                G# is pre-1.0 and evolving. Read the support matrix, inspect the compiler, and
                explore the tests behind the language before choosing it for your project.
              </p>
              <Link className="gs-text-link" to="/project">
                Get to know the project <span aria-hidden="true">&rarr;</span>
              </Link>
            </div>
            <div className={styles.projectLinks}>
              <Link to="/docs/release-notes">
                <span>Release notes</span>
                <small>What changed and how to update</small>
                <span aria-hidden="true">&rarr;</span>
              </Link>
              <Link to="/docs/ref/feature-matrix">
                <span>Feature support</span>
                <small>Capabilities and known limitations</small>
                <span aria-hidden="true">&rarr;</span>
              </Link>
              <Link to="/concurrency">
                <span>Go / G# concurrency</span>
                <small>Ten patterns, correctness, and measured operations</small>
                <span aria-hidden="true">&rarr;</span>
              </Link>
              <Link to="/docs/next/project/quality-dashboard">
                <span>Quality dashboard</span>
                <small>Latest project measurements, with context</small>
                <span aria-hidden="true">&rarr;</span>
              </Link>
            </div>
          </div>
        </section>

        <section className={styles.closing} aria-labelledby="closing-heading">
          <div className="gs-container">
            <p className="gs-eyebrow">Make something with G#</p>
            <Heading as="h2" id="closing-heading">
              Your next idea starts here.
            </Heading>
            <Link className="gs-button gs-button-brand" to="/docs/getting-started/install">
              Create your first project <span aria-hidden="true">&rarr;</span>
            </Link>
          </div>
        </section>
      </main>
    </Layout>
  );
}
