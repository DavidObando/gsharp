import dataSource from '@site/../samples/WebsiteData.gs';
import dataOutput from '@site/../samples/WebsiteData.golden';
import nullableSource from '@site/../samples/WebsiteNullable.gs';
import nullableOutput from '@site/../samples/WebsiteNullable.golden';
import concurrencySource from '@site/../samples/WebsiteConcurrency.gs';
import concurrencyOutput from '@site/../samples/WebsiteConcurrency.golden';
import interopSource from '@site/../samples/WebsiteInterop.gs';
import interopOutput from '@site/../samples/WebsiteInterop.golden';

export const examples = {
  data: {
    id: 'data',
    label: 'Useful data',
    title: 'Model the idea. Skip the boilerplate.',
    description:
      'A data class gives you structural equality and copy-with-update. Describe your data once, then work with values that say what they mean.',
    file: 'point.gs',
    source: dataSource,
    output: dataOutput,
    to: '/docs/tour/types',
    link: 'Explore data types',
  },
  nullable: {
    id: 'nullable',
    label: 'Explicit nullability',
    title: 'Make room for the missing case.',
    description:
      'A nullable type makes absence visible. Use if let to work with a present value, or handle the alternative explicitly.',
    file: 'greeting.gs',
    source: nullableSource,
    output: nullableOutput,
    to: '/docs/tour/control-flow',
    link: 'Learn nullable flow',
  },
  concurrency: {
    id: 'concurrency',
    label: 'Structured concurrency',
    title: 'Start together. Finish together.',
    description:
      'Channels carry values between concurrent work. A scope joins its child tasks before control moves on, and observes their failures.',
    file: 'workers.gs',
    source: concurrencySource,
    output: concurrencyOutput,
    to: '/docs/extensions/go-concurrency',
    link: 'Explore channels and scope',
  },
  interop: {
    id: 'interop',
    label: '.NET libraries',
    title: 'A new language. Familiar libraries.',
    description:
      'Import .NET namespaces and use familiar collections and LINQ. G# produces ordinary managed assemblies, not a separate platform.',
    file: 'collections.gs',
    source: interopSource,
    output: interopOutput,
    to: '/docs/tour/dotnet-interop',
    link: 'Explore .NET interop',
  },
} as const;

export const languageExamples = [
  examples.concurrency,
  examples.data,
  examples.nullable,
  examples.interop,
];
