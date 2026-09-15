export type Hub = {
  kind: 'learn' | 'reference' | 'tooling' | 'project';
  eyebrow: string;
  title: string;
  description: string;
  groups: {
    title: string;
    items: {title: string; description: string; to: string}[];
  }[];
};

export const learn: Hub = {
  kind: 'learn',
  eyebrow: 'Learn G#',
  title: 'Start small. Build understanding.',
  description:
    'Find the right way into G#: a first program, a guided tour, or a bridge from the language you already know.',
  groups: [
    {
      title: 'Your first steps',
      items: [
        {
          title: 'Install G#',
          description: 'Set up the published tools and create a project with the .NET SDK.',
          to: '/docs/getting-started/install',
        },
        {
          title: 'Hello, G#',
          description: 'Run a complete program, understand each line, and make it your own.',
          to: '/docs/getting-started/quickstart',
        },
        {
          title: 'Build Trail',
          description:
            'Put data classes, nullable values, channels, and .NET libraries into one useful application.',
          to: '/docs/tutorials/trail',
        },
        {
          title: 'Inspect and debug',
          description: 'Explore the running project and inspect values in your editor.',
          to: '/docs/tooling/debugging',
        },
      ],
    },
    {
      title: 'Bring your experience',
      items: [
        {
          title: 'For C# developers',
          description:
            'Familiar libraries, different conventions. Compare the concepts side by side.',
          to: '/docs/bridges/gsharp-for-csharp-developers',
        },
        {
          title: 'For Go developers',
          description: 'Get oriented to .NET, nullable types, and the CLR exception model.',
          to: '/docs/bridges/gsharp-for-go-developers',
        },
        {
          title: 'For Kotlin developers',
          description:
            'Familiar data and nullable concepts, a new runtime. Learn where the similarities stop.',
          to: '/docs/bridges/gsharp-for-kotlin-developers',
        },
        {
          title: 'For Swift developers',
          description:
            'Connect optionals and value types to .NET, and understand lifetime and concurrency differences.',
          to: '/docs/bridges/gsharp-for-swift-developers',
        },
        {
          title: 'What is G#?',
          description: 'Understand the language, its goals, and where it fits.',
          to: '/docs/intro',
        },
      ],
    },
    {
      title: 'Put it into practice',
      items: [
        {
          title: 'A Tour of G#',
          description: 'Explore the language one concept at a time, alongside your project.',
          to: '/docs/tour',
        },
        {
          title: 'Ten Go/G# concurrency patterns',
          description:
            'Read runnable pairs, compare correctness and usability, and inspect separately sourced workflow measurements.',
          to: '/concurrency',
        },
        {
          title: 'Write idiomatic G#',
          description: 'Learn the conventions that make code clear and predictable.',
          to: '/docs/guide/effective-gsharp',
        },
        {
          title: 'Projects and packages',
          description: 'Organize source files, reference libraries, and build with MSBuild.',
          to: '/docs/tutorials/project-and-packages',
        },
      ],
    },
  ],
};

export const reference: Hub = {
  kind: 'reference',
  eyebrow: 'Reference',
  title: 'Find the detail you need.',
  description:
    'Look up a language rule, a diagnostic, or an interop boundary. These references describe the released language and its known limitations.',
  groups: [
    {
      title: 'Language and runtime',
      items: [
        {
          title: 'Concept quick reference',
          description:
            'Quick answers, small examples, and important boundaries for nullable values, data, concurrency, and interop.',
          to: '/docs/ref/quick-reference',
        },
        {
          title: 'Language specification',
          description: 'Grammar, types, expressions, statements, and the formal language rules.',
          to: '/docs/ref/spec',
        },
        {
          title: '.NET interop',
          description:
            'CLR types, generics, delegates, events, native calls, and their boundaries.',
          to: '/docs/ref/clr-interop',
        },
        {
          title: 'Standard library',
          description: 'The .NET foundations and G# runtime support available to your programs.',
          to: '/docs/ref/standard-library',
        },
      ],
    },
    {
      title: 'Understand behavior',
      items: [
        {
          title: 'Diagnostics',
          description: 'Search a GSxxxx code and understand its cause and remedy.',
          to: '/docs/ref/diagnostics',
        },
        {
          title: 'Feature support',
          description: 'Check implemented behavior and known limits before choosing an approach.',
          to: '/docs/ref/feature-matrix',
        },
        {
          title: 'Common questions',
          description: 'Quick answers about the language, runtime, tooling, and compatibility.',
          to: '/docs/faq',
        },
      ],
    },
    {
      title: 'Frequently used concepts',
      items: [
        {
          title: 'Types and values',
          description: 'Data types, nullable values, collections, and how they relate.',
          to: '/docs/guide/types-and-values',
        },
        {
          title: 'Concurrency and async',
          description: 'Scope lifetimes, async functions, tasks, and sequences.',
          to: '/docs/guide/concurrency',
        },
        {
          title: 'Go/G# pattern comparison',
          description:
            'Ten concrete contracts, checked implementations, and honest benchmark context.',
          to: '/concurrency',
        },
        {
          title: 'Errors and cleanup',
          description: 'Exceptions, using, and defer for explicit failure and resource management.',
          to: '/docs/guide/errors-and-cleanup',
        },
      ],
    },
  ],
};

export const tooling: Hub = {
  kind: 'tooling',
  eyebrow: 'The G# toolchain',
  title: 'Your workflow. Less friction.',
  description:
    'Create a project with the .NET SDK, add editor support, and use the tools that fit the job. Start with the template workflow; reach for the compiler directly when you need it.',
  groups: [
    {
      title: 'Create, edit, and run',
      items: [
        {
          title: 'SDK and project files',
          description:
            'Build, run, test, and package .gsproj projects with familiar dotnet commands.',
          to: '/docs/tooling/sdk-projects',
        },
        {
          title: 'VS Code',
          description:
            'Install the extension for completion, diagnostics, navigation, and debugging.',
          to: '/docs/tooling/vscode',
        },
        {
          title: 'REPL and scripts',
          description: 'Use gsi to explore an idea interactively or run a source file.',
          to: '/docs/tooling/repl',
        },
      ],
    },
    {
      title: 'Keep code in shape',
      items: [
        {
          title: 'Formatting',
          description: 'Use gsfmt for a consistent, option-free source format.',
          to: '/docs/tooling/gsfmt',
        },
        {
          title: 'Debugging',
          description: 'Set breakpoints and inspect ordinary managed execution with Portable PDBs.',
          to: '/docs/tooling/debugging',
        },
        {
          title: 'Code analyzers',
          description: 'Run diagnostics in your build, or write an analyzer for your team.',
          to: '/docs/tooling/analyzers',
        },
      ],
    },
    {
      title: 'Go further',
      items: [
        {
          title: 'Migrate from C#',
          description:
            'Explore cs2gs translation and its compile, verification, and parity stages.',
          to: '/docs/tooling/cs2gs',
        },
        {
          title: 'Compiler CLI',
          description:
            'Understand direct gsc invocation, references, output, and compiler options.',
          to: '/docs/tooling/gsc',
        },
        {
          title: 'Language server',
          description: 'Connect other editors and inspect supported language-server features.',
          to: '/docs/tooling/lsp',
        },
      ],
    },
  ],
};

export const project: Hub = {
  kind: 'project',
  eyebrow: 'The project',
  title: 'Built in the open. Still evolving.',
  description:
    'G# is a pre-1.0, MIT-licensed language project. Inspect its support, changes, and quality evidence before deciding where to use it.',
  groups: [
    {
      title: 'Make an informed choice',
      items: [
        {
          title: 'Release notes',
          description: 'Read user-facing highlights and the detailed compatibility changes.',
          to: '/docs/release-notes',
        },
        {
          title: 'Feature support',
          description: 'Understand what works and where implementation limits remain.',
          to: '/docs/ref/feature-matrix',
        },
        {
          title: 'Compatibility policy',
          description: 'Read the project’s stability expectations before adopting or upgrading.',
          to: 'https://github.com/DavidObando/gsharp/blob/main/docs/compatibility-and-stability.md',
        },
      ],
    },
    {
      title: 'Inspect the evidence',
      items: [
        {
          title: 'Quality dashboard',
          description:
            'Latest project snapshot: conformance, benchmarks, environment, and methodology. Not a release guarantee.',
          to: '/docs/next/project/quality-dashboard',
        },
        {
          title: 'Design decisions',
          description: 'The reasoning behind language choices, collected in one ADR index.',
          to: '/docs/design-decisions',
        },
        {
          title: 'Development documentation',
          description:
            'Explicitly preview-only: explore Next without confusing it with the release.',
          to: '/docs/next/intro',
        },
      ],
    },
    {
      title: 'Take part',
      items: [
        {
          title: 'Contribute to G#',
          description: 'Find the contribution workflow, source, tests, and ways to help.',
          to: 'https://github.com/DavidObando/gsharp/blob/main/CONTRIBUTING.md',
        },
        {
          title: 'Improve the documentation',
          description: 'Write clear examples, preserve version context, and preview changes.',
          to: '/docs/contributing/docs-authoring',
        },
        {
          title: 'Report an issue',
          description: 'Share a reproducible problem or discuss a language/tooling improvement.',
          to: 'https://github.com/DavidObando/gsharp/issues',
        },
      ],
    },
  ],
};
