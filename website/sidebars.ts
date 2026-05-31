import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// Explicit sidebars mirror the documentation information architecture.
// Three top-level surfaces: Learn, Reference, Tooling.
const sidebars: SidebarsConfig = {
  learnSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Getting started',
      collapsed: false,
      items: ['getting-started/install', 'getting-started/quickstart'],
    },
    {
      type: 'category',
      label: 'A Tour of G#',
      link: {type: 'doc', id: 'tour/index'},
      items: [
        'tour/basics',
        'tour/types',
        'tour/control-flow',
        'tour/concurrency',
        'tour/dotnet-interop',
      ],
    },
    {
      type: 'category',
      label: 'Tutorials',
      items: [
        'tutorials/getting-started',
        'tutorials/project-and-packages',
        'tutorials/data-and-types',
        'tutorials/control-flow',
        'tutorials/concurrency',
        'tutorials/async-and-sequences',
        'tutorials/dotnet-interop',
      ],
    },
    {
      type: 'category',
      label: 'Language guide',
      items: [
        'guide/effective-gsharp',
        'guide/lexical-structure',
        'guide/declarations-and-packages',
        'guide/types-and-values',
        'guide/expressions-and-statements',
        'guide/concurrency-async',
        'guide/errors-and-cleanup',
      ],
    },
    {
      type: 'category',
      label: 'Coming from another language',
      items: [
        'bridges/gsharp-for-go-developers',
        'bridges/gsharp-for-csharp-developers',
      ],
    },
  ],

  referenceSidebar: [
    'ref/spec',
    'ref/standard-library',
    'ref/clr-interop',
    'ref/feature-matrix',
    'ref/diagnostics',
    'design-decisions',
    'release-notes',
    'faq',
  ],

  toolingSidebar: [
    'tooling/gsc',
    'tooling/sdk-projects',
    'tooling/vscode',
    'tooling/lsp',
    'tooling/debugging',
    'tooling/compiler-architecture',
    'playground',
    'contributing/docs-authoring',
  ],
};

export default sidebars;
