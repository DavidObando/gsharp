import type {ReactNode} from 'react';
import Heading from '@theme/Heading';
import raw from '@site/static/data/concurrency-bench.json';

type Measurement = {medianNs: number; intervalNs: number[]; samples: number; runs: number};
export type Snapshot = {
  status: string;
  reason: string | null;
  checkedAt: string;
  source: {
    runUrl: string;
    runId: number;
    commit: string;
    compilerVersion: string;
    artifactExpiresAt: string;
    artifactSha256: string;
  } | null;
  measurement: {
    startedAt: string;
    finishedAt: string;
    cpuModel: string;
    logicalCpuCount: number;
    system: string;
    architecture: string;
    kernel: string;
    hardwareClass: string;
    wholeRuns: number;
    launchesPerRun: number;
    intervalMethod: string;
    launchOrder: string;
    comparable: boolean;
    warnings: string[];
    comparisonKey: string;
    aggregationKey: string;
    benchmarkDefinitionSha256: string;
    jitMode: string;
    toolchains: {
      dotnetSdk: string;
      dotnetRuntime: string[];
      nativeAotRuntime: string[];
      go: string[];
    };
  } | null;
  scenarios: {
    name: string;
    description: string;
    goScenario: string | null;
    jit: Measurement | null;
    aot: Measurement | null;
    go: Measurement | null;
    jitOverGo: number | null;
    aotOverGo: number | null;
  }[];
};

export const benchmarkSnapshot: Snapshot = raw;
const number = (value: number) => value.toLocaleString('en-US', {maximumFractionDigits: 2});

function Cell({value}: {value: Measurement | null}): ReactNode {
  return value ? (
    <>
      <strong>{number(value.medianNs)}</strong>
      <small className="gs-bench-range">{value.intervalNs.map(number).join(' – ')}</small>
    </>
  ) : (
    <span>Not paired</span>
  );
}

export default function ConcurrencyBenchmarks(): ReactNode {
  const data = benchmarkSnapshot;
  if (data.status !== 'available' || !data.source || !data.measurement) {
    return (
      <section className="gs-benchmark" aria-labelledby="benchmark-heading">
        <Heading as="h2" id="benchmark-heading">
          Workflow measurements
        </Heading>
        <p role="status">
          Measurements unavailable: {data.reason ?? 'No valid snapshot is available.'}
        </p>
        <p>
          Last retrieval attempt: <time>{data.checkedAt}</time>. Missing measurements are not zero.
        </p>
      </section>
    );
  }
  const {source, measurement: method} = data;
  return (
    <section className="gs-benchmark" aria-labelledby="benchmark-heading">
      <p className="gs-eyebrow">Measured separately / not example timings</p>
      <Heading as="h2" id="benchmark-heading">
        What the workflow actually measured.
      </Heading>
      <p>
        These are the registered lower-level operations from{' '}
        <a href={source.runUrl}>concurrency-bench.yml run {source.runId}</a>, not end-to-end timings
        of the ten programs above.
      </p>
      <div className="gs-comparison-notice">
        <strong>
          {method.comparable
            ? 'Recorded comparison identity available.'
            : 'Report-only aggregate; not baseline-comparable.'}
        </strong>
        {method.warnings.length > 0 && (
          <ul>
            {method.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
        <p>
          A shared hosted runner is not a named workstation. Ratios describe this run; they are not
          a universal language ranking or a regression gate.
        </p>
      </div>
      <dl className="gs-bench-provenance">
        <div>
          <dt>Measurement finished (UTC)</dt>
          <dd>
            <time>{method.finishedAt}</time>
          </dd>
        </div>
        <div>
          <dt>Compiler / commit</dt>
          <dd>
            G# {source.compilerVersion} / <code>{source.commit.slice(0, 12)}</code>
          </dd>
        </div>
        <div>
          <dt>Host</dt>
          <dd>
            {method.system} {method.architecture}, {method.logicalCpuCount} visible CPUs;{' '}
            {method.cpuModel}
          </dd>
        </div>
        <div>
          <dt>Toolchains</dt>
          <dd>
            .NET SDK {method.toolchains.dotnetSdk}; JIT {method.toolchains.dotnetRuntime.join(', ')}
            ; AOT {method.toolchains.nativeAotRuntime.join(', ')}; {method.toolchains.go.join(', ')}
          </dd>
        </div>
        <div>
          <dt>Method</dt>
          <dd>
            {method.wholeRuns} whole runs × {method.launchesPerRun} process launches per mode;
            rotating/interleaved launch order.
          </dd>
        </div>
        <div>
          <dt>Snapshot retrieved (UTC)</dt>
          <dd>
            <time>{data.checkedAt}</time>
          </dd>
        </div>
      </dl>
      <p>
        Values are <strong>ns per counted operation</strong>. Each cell shows a median and the{' '}
        <strong>range of the three run medians</strong>, not a 95% confidence interval. The source
        field retains a historical interval name; its recorded aggregation method determines the
        meaning.
      </p>
      <div
        className="gs-bench-scroll"
        role="region"
        aria-label="Concurrency benchmark measurements"
        tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th scope="col">Operation</th>
              <th scope="col">G# JIT</th>
              <th scope="col">G# NativeAOT</th>
              <th scope="col">Go</th>
              <th scope="col">JIT / Go</th>
              <th scope="col">AOT / Go</th>
            </tr>
          </thead>
          <tbody>
            {data.scenarios.map((row) => (
              <tr key={row.name}>
                <th scope="row">
                  <Heading as="h3" id={`benchmark-${row.name}`}>
                    {row.name}
                  </Heading>
                  <small>{row.description}</small>
                </th>
                <td>
                  <Cell value={row.jit} />
                </td>
                <td>
                  <Cell value={row.aot} />
                </td>
                <td>
                  <Cell value={row.go} />
                </td>
                <td>{row.jitOverGo === null ? '—' : `${number(row.jitOverGo)}×`}</td>
                <td>{row.aotOverGo === null ? '—' : `${number(row.aotOverGo)}×`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        A ratio below 1 means the recorded G# median was lower for that paired operation; above 1
        means it was higher. No ratio is shown when the registry deliberately has no equivalent Go
        workload. In particular, do not substitute the round-trip Go row for a one-handoff G# row,
        or equate copied chunks with transported array/slice references.
      </p>
      <details>
        <summary>Provenance and interpretation limits</summary>
        <p>
          JIT mode: <code>{method.jitMode}</code>. Aggregate interval:{' '}
          <code>{method.intervalMethod}</code>. Kernel: <code>{method.kernel}</code>.
        </p>
        <p>
          Comparison key: <code>{method.comparisonKey}</code>
          <br />
          Aggregation key: <code>{method.aggregationKey}</code>
          <br />
          Benchmark definition: <code>{method.benchmarkDefinitionSha256}</code>
          <br />
          Source payload: <code>{source.artifactSha256}</code>
        </p>
        <p>
          The GitHub artifact expires at {source.artifactExpiresAt}; this static snapshot retains
          its provenance. Refreshes select successful main-branch runs, validate the source
          identity, and use the registry from the measured commit. They do not edit performance
          baselines.
        </p>
        <p>
          Read the{' '}
          <a
            href={`https://github.com/DavidObando/gsharp/blob/${source.commit}/bench/concurrency/README.md`}>
            methodology at the measured commit
          </a>{' '}
          and the{' '}
          <a
            href={`https://github.com/DavidObando/gsharp/blob/${source.commit}/bench/concurrency/scenarios.json`}>
            pairing registry
          </a>{' '}
          before drawing conclusions.
        </p>
      </details>
    </section>
  );
}
