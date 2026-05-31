import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';
import HomepageFeatures from '@site/src/components/HomepageFeatures';

import styles from './index.module.css';

const heroSample = `package Hello

import System

func greet(name string) string {
\treturn "Hello, \${name}!"
}

Console.WriteLine(greet("world"))`;

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero', styles.heroBanner)}>
      <div className="container">
        <div className={styles.heroInner}>
          <div className={styles.heroText}>
            <Heading as="h1" className={styles.heroTitle}>
              {siteConfig.title}
            </Heading>
            <p className={styles.heroSubtitle}>{siteConfig.tagline}</p>
            <p className={styles.heroLede}>
              G# blends Go&apos;s clarity — packages, <code>func</code>,
              goroutines, channels and <code>defer</code> — with the .NET
              runtime and its libraries. Source compiles directly to managed
              assemblies.
            </p>
            <div className={styles.buttons}>
              <Link
                className="button button--primary button--lg"
                to="/docs/getting-started/install">
                Get started
              </Link>
              <Link
                className="button button--secondary button--lg"
                to="/docs/tour">
                Take the tour
              </Link>
            </div>
          </div>
          <div className={styles.heroCode}>
            <CodeBlock language="gsharp" title="hello.gs">
              {heroSample}
            </CodeBlock>
          </div>
        </div>
      </div>
    </header>
  );
}

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={`${siteConfig.title} — ${siteConfig.tagline}`}
      description="G# is a Go-inspired programming language that compiles to the .NET runtime.">
      <HomepageHeader />
      <main>
        <HomepageFeatures />
      </main>
    </Layout>
  );
}
