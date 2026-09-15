import source from '@site/../samples/Trail/Program.gs';
import report from './trail-report.json';
import release from './release.json';

function excerpt(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < from) throw new Error(`Missing Trail source section: ${start}`);
  return source.slice(from, to).trim();
}

export const trail = {
  source,
  report,
  download: `/downloads/trail-${release.version}.zip`,
  model: excerpt('public data class FileEntry', 'func inspect('),
  worker: excerpt('func worker(', 'func inspectAll('),
  inspect: excerpt('func inspect(', 'func discover('),
};
