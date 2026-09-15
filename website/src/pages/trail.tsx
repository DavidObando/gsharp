import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import CodeBlock from '@theme/CodeBlock';
import {trail} from '@site/src/data/trail';
import release from '@site/src/data/release.json';
import EditorProof from '@site/src/components/EditorProof';
import styles from './trail.module.css';

export default function Trail(): ReactNode {
  const download = useBaseUrl(trail.download);
  const diagram = useBaseUrl('/img/trail-pipeline.svg');
  return (
    <Layout
      title="Build Trail: a real G# project"
      description="Build a read-only workspace inventory with G# data classes, nullable filters, bounded channels, structured concurrency, and .NET IO, hashing, and JSON.">
      <main data-pagefind-body data-pagefind-filter="version:general">
        <header className={styles.hero}>
          <div className="gs-container">
            <p className="gs-eyebrow">Trail / A real .NET project, in G#</p>
            <Heading as="h1">
              Know what&apos;s in
              <br />
              your workspace.
            </Heading>
            <p className={styles.lede}>
              Scan local project files. Compute their hashes with a bounded worker pool. Get a
              sorted JSON report you can inspect, compare, or use in another tool.
            </p>
            <div className="gs-actions">
              <a className="gs-button gs-button-brand" href={download} download>
                Download the complete project
              </a>
              <Link className="gs-button gs-button-ghost" to="/docs/tutorials/trail">
                Build it step by step <span aria-hidden="true">&rarr;</span>
              </Link>
            </div>
            <p className={styles.note}>
              Published SDK {release.version} · .NET 10 · No extra packages or accounts
            </p>
          </div>
        </header>
        <section className="gs-section">
          <div className={`gs-container ${styles.split}`}>
            <div>
              <p className="gs-eyebrow">From download to a useful result</p>
              <Heading as="h2">Unzip. Run. Inspect.</Heading>
              <p>
                From the extracted Trail folder, run the bundled demo. Add an extension to narrow
                the report. Your files are read, never modified or uploaded.
              </p>
              <CodeBlock language="bash">{'dotnet run -- demo\ndotnet run -- demo .txt'}</CodeBlock>
              <p className="gs-small">
                The output shown is the verified bundled example, not a live browser execution.
              </p>
            </div>
            <div className={styles.result}>
              <p className="gs-eyebrow">Bundled demo / verified result</p>
              <dl className={styles.metrics}>
                <div>
                  <dt>Files</dt>
                  <dd>{trail.report.files.length}</dd>
                </div>
                <div>
                  <dt>Bytes</dt>
                  <dd>{trail.report.totalBytes}</dd>
                </div>
                <div>
                  <dt>Failures</dt>
                  <dd>{trail.report.failed}</dd>
                </div>
              </dl>
              <ul>
                {trail.report.files.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code>
                    <span>{file.bytes} bytes</span>
                  </li>
                ))}
              </ul>
              <details>
                <summary>Inspect the full JSON report</summary>
                <CodeBlock language="json">{JSON.stringify(trail.report, null, 2)}</CodeBlock>
              </details>
            </div>
          </div>
        </section>
        <section className={`gs-section ${styles.pipeline}`}>
          <div className="gs-container">
            <p className="gs-eyebrow">Concurrency you can follow</p>
            <Heading as="h2">
              A small pipeline.
              <br />
              Clear ownership.
            </Heading>
            <p className={styles.lede}>
              Discovery supplies paths. Workers inspect files. One collector owns the report. Each
              stage closes its output, and scopes join the work they own.
            </p>
            <img
              src={diagram}
              width="1200"
              height="310"
              alt="Discovery feeds an eight-item jobs channel; four workers send records through an eight-item results channel to one report collector."
              loading="lazy"
            />
            <div className={styles.split}>
              <div>
                <Heading as="h3">Model success and failure.</Heading>
                <p>A nullable hash or error makes the outcome visible in the data model.</p>
                <CodeBlock language="gsharp" title="Program.gs / data model excerpt">
                  {trail.model}
                </CodeBlock>
              </div>
              <div>
                <Heading as="h3">Express the worker directly.</Heading>
                <p>Channel direction tells you what a stage can read and write.</p>
                <CodeBlock language="gsharp" title="Program.gs / worker excerpt">
                  {trail.worker}
                </CodeBlock>
              </div>
            </div>
          </div>
        </section>
        <section className="gs-section">
          <div className={`gs-container ${styles.split}`}>
            <div>
              <p className="gs-eyebrow">Use the runtime you know</p>
              <Heading as="h2">
                .NET does the
                <br />
                heavy lifting.
              </Heading>
              <p>
                File streams, SHA-256, JSON serialization, and collections come from the base class
                library. G# supplies the data models, nullable flow, channel syntax, and scope
                boundaries.
              </p>
              <p>
                IO errors become report entries and a nonzero exit code. Traversal failures are
                reported instead of producing a misleading partial success.
              </p>
              <Link className="gs-text-link" to="/docs/tutorials/trail">
                Explore the implementation <span aria-hidden="true">&rarr;</span>
              </Link>
            </div>
            <CodeBlock language="gsharp" title="Program.gs / file inspection excerpt">
              {trail.inspect}
            </CodeBlock>
          </div>
        </section>
        <section className={`gs-section ${styles.pipeline}`}>
          <div className="gs-container">
            <EditorProof />
            <Heading as="h2">
              Small enough to understand.
              <br />
              Complete enough to change.
            </Heading>
            <p className={styles.lede}>
              This is a local project-file example, not a filesystem sandbox. Symbolic links
              encountered during enumeration are skipped, files can change during a scan, and report
              metadata is retained in memory.
            </p>
            <details className={styles.source}>
              <summary>Read the complete Program.gs</summary>
              <CodeBlock language="gsharp" title="Program.gs">
                {trail.source}
              </CodeBlock>
            </details>
            <div className="gs-actions">
              <a className="gs-button gs-button-outline" href={download} download>
                Get Trail for SDK {release.version}
              </a>
              <Link className="gs-text-link" to="/docs/bridges/gsharp-for-kotlin-developers">
                Coming from Kotlin? <span aria-hidden="true">&rarr;</span>
              </Link>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
