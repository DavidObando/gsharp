import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  icon: string;
  description: ReactNode;
  to?: string;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'Go-inspired syntax',
    icon: '⚡',
    description: (
      <>
        Packages and imports, <code>func</code> declarations, slices and maps,
        <code> defer</code>, and <code>for … in</code> ranges. Familiar if you
        know Go, with a few pragmatic differences.
      </>
    ),
    to: '/docs/tour',
  },
  {
    title: 'Runs on .NET',
    icon: '🔷',
    description: (
      <>
        G# compiles straight to managed assemblies and runs on the modern .NET
        runtime. Import any CLR type, call its methods, and ship a normal
        executable.
      </>
    ),
    to: '/docs/ref/clr-interop',
  },
  {
    title: 'Concurrency built in',
    icon: '🧵',
    description: (
      <>
        Launch work with <code>go</code>, communicate over typed{' '}
        <code>chan</code> channels, coordinate with <code>select</code>, and
        write <code>async</code>/<code>await</code> code over sequences.
      </>
    ),
    to: '/docs/guide/concurrency-async',
  },
  {
    title: 'Precise numeric types',
    icon: '🔢',
    description: (
      <>
        Width-bearing primitives like <code>int32</code>, <code>uint64</code>,
        and <code>float64</code> make the size of every value explicit — no
        guessing.
      </>
    ),
    to: '/docs/guide/types-and-values',
  },
  {
    title: 'Real tooling',
    icon: '🛠️',
    description: (
      <>
        A command-line compiler (<code>gsc</code>), an MSBuild SDK, a VS Code
        extension, a language server, and Portable PDB debugging.
      </>
    ),
    to: '/docs/tooling/gsc',
  },
  {
    title: 'A complete specification',
    icon: '📘',
    description: (
      <>
        Learn the language from a single, implementation-grounded
        specification, plus tutorials and an &quot;Effective G#&quot; idioms
        guide.
      </>
    ),
    to: '/docs/ref/spec',
  },
];

function Feature({title, icon, description, to}: FeatureItem) {
  const inner = (
    <div className={styles.featureCard}>
      <div className={styles.featureIcon} aria-hidden="true">
        {icon}
      </div>
      <Heading as="h3" className={styles.featureTitle}>
        {title}
      </Heading>
      <p className={styles.featureDescription}>{description}</p>
    </div>
  );
  return (
    <div className={clsx('col col--4', styles.featureCol)}>
      {to ? (
        <Link to={to} className={styles.featureLink}>
          {inner}
        </Link>
      ) : (
        inner
      )}
    </div>
  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
