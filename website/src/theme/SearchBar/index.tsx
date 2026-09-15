import {useEffect, useId, useRef, useState, type ReactNode} from 'react';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import {useLocation} from '@docusaurus/router';
import {useActiveDocContext, useVersions} from '@docusaurus/plugin-content-docs/client';
import {useColorMode} from '@docusaurus/theme-common';
import release from '@site/src/data/release.json';
import styles from './styles.module.css';

type SearchInstance = {
  on(event: 'error', listener: (error: unknown) => void, owner: Element): void;
  triggerFilters(filters: {version: {any: string[]}}): void;
  triggerSearch(term: string): void;
  triggerLoad(): Promise<void>;
};
type SearchUI = {
  configureInstance(name: string, options: {bundlePath: string; baseUrl: string}): SearchInstance;
  getInstanceManager(): {removeInstance(name: string): void};
};
declare global {
  interface Window {
    PagefindComponents?: SearchUI;
  }
}

let searchUI: Promise<SearchUI> | undefined;

function loadSearchUI(bundlePath: string): Promise<SearchUI> {
  if (!searchUI) {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = `${bundlePath}pagefind-component-ui.css`;
    const stylesReady = new Promise<void>((resolve, reject) => {
      stylesheet.onload = () => resolve();
      stylesheet.onerror = () => {
        stylesheet.remove();
        reject(new Error('Could not load search styles'));
      };
    });
    document.head.append(stylesheet);
    // Load Pagefind's generated browser bundle without rebundling its dynamic imports.
    searchUI = Promise.all([
      import(/* webpackIgnore: true */ `${bundlePath}pagefind-component-ui.js`),
      stylesReady,
    ])
      .then(() => {
        if (!window.PagefindComponents) throw new Error('Search UI did not initialize');
        return window.PagefindComponents;
      })
      .catch((error: unknown) => {
        stylesheet.remove();
        searchUI = undefined;
        throw error;
      });
  }
  return searchUI;
}

export default function SearchBar(): ReactNode {
  const [open, setOpen] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<string>();
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const inputContainer = useRef<HTMLDivElement>(null);
  const query = useRef('');
  const activeSearch = useRef<SearchInstance | undefined>(undefined);
  const instanceId = useId();
  const headingId = useId();
  const {pathname} = useLocation();
  const {colorMode} = useColorMode();
  const {activeVersion} = useActiveDocContext(undefined);
  const versions = useVersions(undefined);
  const version = selectedVersion ?? activeVersion?.name ?? release.docsVersion;
  const bundlePath = useBaseUrl('/pagefind/');
  const baseUrl = useBaseUrl('/');

  function closeSearch() {
    query.current = inputContainer.current?.querySelector('input')?.value ?? query.current;
    dialog.current?.close();
    trigger.current?.focus();
  }

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'k' &&
        !(
          event.target instanceof HTMLElement &&
          (event.target.matches('input, textarea, select') || event.target.isContentEditable)
        )
      ) {
        event.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);

  useEffect(() => {
    dialog.current?.close();
    setOpen(false);
    setSelectedVersion(undefined);
    query.current = '';
  }, [pathname]);

  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);

  useEffect(() => {
    if (!open || !content.current || !inputContainer.current) return;
    const container = content.current;
    const inputHost = inputContainer.current;
    const name = `${instanceId}-${version}`;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    setReady(false);
    setError(false);

    async function load() {
      try {
        const {configureInstance, getInstanceManager} = await loadSearchUI(bundlePath);
        if (cancelled) return;
        const instance = configureInstance(name, {bundlePath, baseUrl});
        activeSearch.current = instance;
        dispose = () => getInstanceManager().removeInstance(name);
        instance.on(
          'error',
          () => {
            if (!cancelled) setError(true);
          },
          container,
        );
        instance.triggerFilters({version: {any: [version, 'general']}});

        const input = document.createElement('pagefind-input');
        input.setAttribute('placeholder', 'Search concepts, tools, or GSxxxx diagnostics');
        input.addEventListener('input', (event) => {
          if (event.target instanceof HTMLInputElement) query.current = event.target.value;
        });
        const summary = document.createElement('pagefind-summary');
        const results = document.createElement('pagefind-results');
        const template = document.createElement('script');
        template.type = 'text/pagefind-template';
        template.textContent = `<li class="gs-search-result">
          <a href="{{ url | safeUrl }}"><span class="gs-search-version">{{ meta.section | default("Website") }} / {{ meta.version | default("General") }}</span>
          <strong>{{ meta.title }}</strong><p>{{+ excerpt +}}</p></a>
          {{#each sub_results as section}}<a class="gs-search-section" href="{{ section.url | safeUrl }}">{{ section.title }}</a>{{/each}}
        </li>`;
        results.append(template);
        for (const element of [input, summary, results]) element.setAttribute('instance', name);
        inputHost.replaceChildren(input);
        container.replaceChildren(summary, results);
        await instance.triggerLoad();
        if (!cancelled) {
          setReady(true);
          if (query.current) instance.triggerSearch(query.current);
          input.querySelector('input')?.focus();
        }
      } catch (cause) {
        if (!cancelled) {
          console.error('Could not initialize documentation search', cause);
          setError(true);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
      container.replaceChildren();
      inputHost.replaceChildren();
      activeSearch.current = undefined;
      dispose?.();
    };
  }, [open, version, bundlePath, baseUrl, instanceId, attempt]);

  return (
    <>
      <button
        ref={trigger}
        className={styles.trigger}
        type="button"
        aria-label="Search documentation"
        aria-keyshortcuts="Meta+k Control+k"
        onClick={() => setOpen(true)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="6.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="m15 15 6 6" stroke="currentColor" strokeWidth="1.8" />
        </svg>
        <span>Search</span>
        <kbd>Ctrl / &#8984; K</kbd>
      </button>
      <dialog
        ref={dialog}
        className={styles.dialog}
        data-pf-theme={colorMode}
        aria-labelledby={headingId}
        onClose={() => setOpen(false)}
        onKeyDownCapture={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeSearch();
          }
        }}>
        <div className={styles.controls}>
          <div className={styles.header}>
            <h2 id={headingId}>Find your way.</h2>
            <button type="button" onClick={closeSearch} aria-label="Close search">
              Close
            </button>
          </div>
          <label className={styles.version}>
            Search documentation
            <select
              value={version}
              onChange={(event) => {
                query.current =
                  inputContainer.current?.querySelector('input')?.value ?? query.current;
                setSelectedVersion(event.target.value);
              }}>
              {versions.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name === 'current' ? 'Next (preview)' : item.label}
                </option>
              ))}
            </select>
          </label>
          <p className={styles.hint}>
            Results include the selected version and the website. Search stays on this site.
          </p>
          <div className={styles.suggestions} aria-label="Search by concept">
            <button
              type="button"
              disabled={!ready}
              onClick={() => activeSearch.current?.triggerSearch('null conditional access')}>
              ?. safe access
            </button>
            <button
              type="button"
              disabled={!ready}
              onClick={() => activeSearch.current?.triggerSearch('null coalescing')}>
              ?? fallback
            </button>
            <button
              type="button"
              disabled={!ready}
              onClick={() => activeSearch.current?.triggerSearch('channels')}>
              chan[T] channels
            </button>
          </div>
          <div ref={inputContainer} hidden={error} />
        </div>
        <div className={styles.results}>
          {!ready && !error && <p role="status">Loading search...</p>}
          {error && (
            <div role="alert" className={styles.error}>
              <p>
                Search is unavailable. A local preview needs a production build and search index.
              </p>
              <p>
                <Link to="/learn">Browse Learn</Link> or <Link to="/reference">Reference</Link>, or{' '}
                <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                  try again
                </button>
                .
              </p>
            </div>
          )}
          <div ref={content} hidden={error} />
        </div>
      </dialog>
    </>
  );
}
