import * as vscode from 'vscode';
import {
  findTestAtPosition,
  populateTestItems,
  sameDocumentUri,
  TestItem as DiscoveredTestItem,
} from '../features/testing';

function createCollection() {
  const items = new Map<string, vscode.TestItem>();
  return {
    get size() {
      return items.size;
    },
    add(item: vscode.TestItem) {
      items.set(item.id, item);
    },
    delete(id: string) {
      items.delete(id);
    },
    get(id: string) {
      return items.get(id);
    },
    replace(replacements: readonly vscode.TestItem[]) {
      items.clear();
      for (const item of replacements) {
        items.set(item.id, item);
      }
    },
    forEach(callback: (item: vscode.TestItem) => unknown) {
      items.forEach(callback);
    },
  } as vscode.TestItemCollection;
}

function createController(): vscode.TestController {
  return {
    items: createCollection(),
    createTestItem(id: string, label: string, uri?: vscode.Uri) {
      const item = {
        id,
        label,
        uri,
        children: createCollection(),
      } as vscode.TestItem;
      const add = item.children.add.bind(item.children);
      item.children.add = (child) => {
        Object.defineProperty(child, 'parent', { value: item });
        add(child);
      };
      return item;
    },
  } as vscode.TestController;
}

describe('findTestAtPosition', () => {
  it('prefers the project-backed duplicate when file URI encoding differs', () => {
    const controller = createController();
    const tests: DiscoveredTestItem[] = [
      {
        id: 'loose',
        label: 'RunsInVsCode',
        uri: 'file:///c%3A/work/Live.Tests/LiveTests.gs',
        line: 7,
        filter: 'Live.Tests.LiveTests.RunsInVsCode',
      },
      {
        id: 'project:C:\\work\\Live.Tests\\Live.Tests.gsproj',
        label: 'Live.Tests (net10.0)',
        uri: 'file:///c:/work/Live.Tests/Live.Tests.gsproj',
        line: 0,
        projectFile: 'C:\\work\\Live.Tests\\Live.Tests.gsproj',
        children: [
          {
            id: 'project-test',
            label: 'RunsInVsCode',
            uri: 'file:///c:/work/Live.Tests/LiveTests.gs',
            line: 7,
            filter: 'Live.Tests.LiveTests.RunsInVsCode',
          },
        ],
      },
    ];
    populateTestItems(controller, tests);

    const selected = findTestAtPosition(
      controller.items,
      vscode.Uri.parse('file:///c%3A/work/Live.Tests/LiveTests.gs'),
      { line: 7, character: 4 } as vscode.Position,
    );

    expect(selected?.id).toBe('project-test');
  });
});

describe('sameDocumentUri', () => {
  const upper = vscode.Uri.parse('file:///workspace/Foo.gs');
  const lower = vscode.Uri.parse('file:///workspace/foo.gs');

  it('ignores file path casing on Windows', () => {
    expect(sameDocumentUri(upper, lower, 'win32')).toBe(true);
  });

  it('preserves file path casing on case-sensitive platforms', () => {
    expect(sameDocumentUri(upper, lower, 'linux')).toBe(false);
  });
});
