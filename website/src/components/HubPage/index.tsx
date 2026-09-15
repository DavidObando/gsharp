import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import type {Hub} from '@site/src/data/hubs';
import release from '@site/src/data/release.json';
import EditorProof from '@site/src/components/EditorProof';
import styles from './styles.module.css';

export default function HubPage({hub}: {hub: Hub}): ReactNode {
  return (
    <Layout title={hub.eyebrow} description={hub.description}>
      <main className={styles.hub} data-pagefind-body data-pagefind-filter="version:general">
        <header className={styles.header}>
          <div className="gs-container">
            <p className="gs-eyebrow">{hub.eyebrow}</p>
            <Heading as="h1">{hub.title}</Heading>
            <p className={styles.description}>{hub.description}</p>
            <p className="gs-small">
              Documentation for G# {release.version}.{' '}
              <Link to="/docs/next/intro">Looking for Next?</Link>
            </p>
          </div>
        </header>
        <div className="gs-container">
          {hub.kind === 'tooling' && (
            <section className={styles.featured}>
              <div>
                <p className="gs-eyebrow">See the workflow</p>
                <Heading as="h2">Real code. Real editor support.</Heading>
                <p>
                  Trail is a complete G# application you can build with the published SDK, inspect
                  in your editor, and run from a terminal.
                </p>
                <Link className="gs-text-link" to="/trail">
                  Explore Trail <span aria-hidden="true">&rarr;</span>
                </Link>
              </div>
              <EditorProof />
            </section>
          )}
          {hub.kind === 'project' && (
            <section className={styles.status} aria-label="Project status">
              <div>
                <span>Compatibility</span>
                <strong>Pre-1.0</strong>
              </div>
              <div>
                <span>Example SDK</span>
                <strong>{release.version}</strong>
              </div>
              <div>
                <span>Source and license</span>
                <strong>Open / MIT</strong>
              </div>
              <p>
                Published instructions and preview documentation are separate. Check support for the
                features your project needs.
              </p>
            </section>
          )}
          {hub.groups.map((group, index) => (
            <section className={styles.group} key={group.title}>
              <Heading as="h2">{group.title}</Heading>
              {hub.kind === 'learn' && index === 0 ? (
                <ol className={styles.learningPath}>
                  {group.items.map((item, step) => (
                    <li key={item.to}>
                      <span>{String(step + 1).padStart(2, '0')}</span>
                      <div>
                        <Heading as="h3">
                          <Link to={item.to}>{item.title}</Link>
                        </Heading>
                        <p>{item.description}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : hub.kind === 'reference' || hub.kind === 'project' ? (
                <dl className={styles.referenceList}>
                  {group.items.map((item) => (
                    <div key={item.to}>
                      <dt>
                        <Link to={item.to}>
                          {item.title} <span aria-hidden="true">&rarr;</span>
                        </Link>
                      </dt>
                      <dd>{item.description}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <div className={`gs-card-grid ${hub.kind === 'learn' ? styles.learningCards : ''}`}>
                  {group.items.map((item) => (
                    <Link className="gs-card" key={item.to} to={item.to}>
                      <Heading as="h3">{item.title}</Heading>
                      <p>{item.description}</p>
                      <span className="gs-text-link">
                        Read guide <span aria-hidden="true">&rarr;</span>
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          ))}
          {hub.kind === 'project' && (
            <section className={styles.group}>
              <Heading as="h2">Explore projects written in G#</Heading>
              <p>Independent projects with their own requirements, licenses, and release cycles.</p>
              <dl className={styles.referenceList}>
                <div>
                  <dt>
                    <Link to="https://github.com/DavidObando/Oahu">
                      Oahu <span aria-hidden="true">&rarr;</span>
                    </Link>
                  </dt>
                  <dd>
                    An application with graphical, terminal, and programmatic clients around shared
                    G# libraries.
                  </dd>
                </div>
                <div>
                  <dt>
                    <Link to="https://github.com/obselate/goo">
                      goo <span aria-hidden="true">&rarr;</span>
                    </Link>
                  </dt>
                  <dd>
                    A retained desktop UI framework with G# controls and runnable gallery examples.
                  </dd>
                </div>
              </dl>
            </section>
          )}
        </div>
      </main>
    </Layout>
  );
}
