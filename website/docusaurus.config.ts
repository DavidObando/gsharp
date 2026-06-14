import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'G#',
  tagline: 'A modern .NET language with Go, Kotlin, and Swift ergonomics',
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

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/DavidObando/gsharp/tree/main/website/',
          // Docs versioning is enabled. While authoring, "current" is served at
          // /docs/. A released version snapshot (e.g. 0.1) is cut before
          // release, after which the version dropdown lists released + "Next".
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
    image: 'img/gsharp-icon.png',
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
          type: 'docSidebar',
          sidebarId: 'learnSidebar',
          position: 'left',
          label: 'Learn',
        },
        {
          type: 'docSidebar',
          sidebarId: 'referenceSidebar',
          position: 'left',
          label: 'Reference',
        },
        {
          type: 'docSidebar',
          sidebarId: 'toolingSidebar',
          position: 'left',
          label: 'Tooling',
        },
        {
          to: '/docs/tour',
          label: 'Tour',
          position: 'left',
        },
        {
          type: 'docsVersionDropdown',
          position: 'right',
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
            {label: 'Introduction', to: '/docs/intro'},
            {label: 'Install', to: '/docs/getting-started/install'},
            {label: 'Tour of G#', to: '/docs/tour'},
            {label: 'Tutorials', to: '/docs/tutorials/getting-started'},
            {label: 'Effective G#', to: '/docs/guide/effective-gsharp'},
          ],
        },
        {
          title: 'Reference',
          items: [
            {label: 'Language specification', to: '/docs/ref/spec'},
            {label: 'CLR interop', to: '/docs/ref/clr-interop'},
            {label: 'Diagnostics', to: '/docs/ref/diagnostics'},
            {label: 'Feature matrix', to: '/docs/ref/feature-matrix'},
          ],
        },
        {
          title: 'More',
          items: [
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
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['csharp', 'go', 'bash', 'json'],
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
