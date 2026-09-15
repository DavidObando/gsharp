import type {ReactNode} from 'react';
import Content from '@theme-original/DocItem/Content';
import {useDoc, useDocsVersion} from '@docusaurus/plugin-content-docs/client';
import type {Props} from '@theme/DocItem/Content';

export default function DocContent(props: Props): ReactNode {
  const {version, label} = useDocsVersion();
  const {metadata} = useDoc();
  const sections: Record<string, string> = {
    ref: 'Reference',
    guide: 'Guide',
    tooling: 'Tooling',
    tour: 'Tour',
    tutorials: 'Tutorial',
    bridges: 'Language bridge',
    project: 'Project',
    'getting-started': 'Getting started',
  };
  const section = sections[metadata.id.split('/')[0]] ?? 'Documentation';
  return (
    <div
      data-pagefind-body
      data-pagefind-filter={`version:${version}`}
      data-search-version={label}
      data-search-section={section}
      data-pagefind-meta="version[data-search-version], section[data-search-section]">
      <Content {...props} />
    </div>
  );
}
