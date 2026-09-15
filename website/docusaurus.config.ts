import type {PrismTheme} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import path from 'node:path';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const codeTheme: PrismTheme = {
  plain: {color: 'var(--gs-code-text)', backgroundColor: 'var(--gs-code-background)'},
  styles: [
    {
      types: ['comment', 'prolog', 'doctype', 'cdata'],
      style: {color: 'var(--gs-code-comment)', fontStyle: 'italic'},
    },
    {
      types: ['keyword', 'selector', 'atrule', 'boolean'],
      style: {color: 'var(--gs-code-keyword)'},
    },
    {
      types: ['string', 'char', 'attr-value', 'raw-string'],
      style: {color: 'var(--gs-code-string)'},
    },
    {types: ['number', 'constant', 'symbol'], style: {color: 'var(--gs-code-number)'}},
    {types: ['function', 'tag'], style: {color: 'var(--gs-code-function)'}},
    {
      types: ['class-name', 'attr-name', 'annotation', 'builtin', 'builtin-type'],
      style: {color: 'var(--gs-code-type)'},
    },
    {
      types: ['operator', 'punctuation', 'parameter', 'variable', 'property'],
      style: {color: 'var(--gs-code-text)'},
    },
  ],
};

const config: Config = {
  title: 'G#',
  tagline: 'A fresh way to build on .NET',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  // Production URL and base path for the GitHub Pages project site.
  url: 'https://davidobando.github.io',
  baseUrl: '/gsharp/',

  organizationName: 'DavidObando',
  projectName: 'gsharp',

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  plugins: [
    function sourceExamples() {
      return {
        name: 'gsharp-source-examples',
        configureWebpack() {
          return {
            module: {
              rules: [
                {
                  test: /\.(gs|golden)$/,
                  include: path.resolve(__dirname, '../samples'),
                  type: 'asset/source',
                },
              ],
            },
          };
        },
      };
    },
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/DavidObando/gsharp/tree/main/website/',
          // Released 0.4 docs use /docs; development docs use /docs/next.
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
        sitemap: {
          changefreq: 'weekly',
          priority: 0.5,
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/social-preview.png',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    metadata: [
      {
        name: 'keywords',
        content:
          'gsharp, g sharp, programming language, go, dotnet, clr, compiler, language reference',
      },
    ],
    navbar: {
      title: 'G#',
      logo: {
        alt: 'G# logo',
        src: 'img/gsharp-logo.svg',
      },
      items: [
        {
          to: '/learn',
          activeBaseRegex:
            '/(learn|trail|concurrency|docs/(next/|[0-9.]+/)?(intro|getting-started|tour|tutorials|guide|bridges|extensions))(/|$)',
          position: 'left',
          label: 'Learn',
        },
        {
          to: '/reference',
          activeBaseRegex: '/(reference|docs/(next/|[0-9.]+/)?(ref|faq))(/|$)',
          position: 'left',
          label: 'Reference',
        },
        {
          to: '/tooling',
          activeBaseRegex: '/(tooling|docs/(next/|[0-9.]+/)?tooling)(/|$)',
          position: 'left',
          label: 'Tooling',
        },
        {
          to: '/project',
          activeBaseRegex:
            '/(project|docs/(next/|[0-9.]+/)?(project|release-notes|design-decisions|contributing))(/|$)',
          label: 'Project',
          position: 'left',
        },
        {
          type: 'docsVersionDropdown',
          position: 'right',
          className: 'gs-docs-version',
        },
        {
          href: 'https://github.com/DavidObando/gsharp',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Learn',
          items: [
            {label: 'Learning paths', to: '/learn'},
            {label: 'Install', to: '/docs/getting-started/install'},
            {label: 'Tour of G#', to: '/docs/tour'},
            {label: 'Tutorials', to: '/docs/tutorials/getting-started'},
            {label: 'Effective G#', to: '/docs/guide/effective-gsharp'},
            {label: 'Go / G# concurrency', to: '/concurrency'},
          ],
        },
        {
          title: 'Reference',
          items: [
            {label: 'Find a reference', to: '/reference'},
            {label: 'Language specification', to: '/docs/ref/spec'},
            {label: 'CLR interop', to: '/docs/ref/clr-interop'},
            {label: 'Diagnostics', to: '/docs/ref/diagnostics'},
            {label: 'Feature matrix', to: '/docs/ref/feature-matrix'},
          ],
        },
        {
          title: 'Tooling',
          items: [
            {label: 'The toolchain', to: '/tooling'},
            {label: 'SDK projects', to: '/docs/tooling/sdk-projects'},
            {label: 'VS Code', to: '/docs/tooling/vscode'},
            {label: 'REPL and scripts', to: '/docs/tooling/repl'},
          ],
        },
        {
          title: 'Project',
          items: [
            {label: 'About the project', to: '/project'},
            {label: 'Quality dashboard', to: '/docs/next/project/quality-dashboard'},
            {label: 'FAQ', to: '/docs/faq'},
            {label: 'Release notes', to: '/docs/release-notes'},
            {label: 'Design decisions', to: '/docs/design-decisions'},
            {label: 'GitHub', href: 'https://github.com/DavidObando/gsharp'},
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} The G# Authors. Built with Docusaurus.`,
    },
    prism: {
      theme: codeTheme,
      darkTheme: codeTheme,
      additionalLanguages: ['csharp', 'go', 'kotlin', 'swift', 'bash', 'json'],
      magicComments: [
        {
          className: 'theme-code-block-highlighted-line',
          line: 'highlight-next-line',
          block: {start: 'highlight-start', end: 'highlight-end'},
        },
      ],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
