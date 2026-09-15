import {useState, type ReactNode} from 'react';
import release from '@site/src/data/release.json';

export const installCommands = `dotnet new install Gsharp.Templates::${release.version}
dotnet new gsharp-console -n MyApp
cd MyApp
dotnet run`;

export default function InstallCommands(): ReactNode {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copy() {
    try {
      await navigator.clipboard.writeText(installCommands);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  }

  return (
    <div className="gs-terminal">
      <div className="gs-terminal-bar">
        <span>Terminal</span>
        <button type="button" onClick={copy}>
          {status === 'copied' ? 'Copied' : 'Copy commands'}
        </button>
      </div>
      <pre aria-label="Installation commands">
        <code>{installCommands}</code>
      </pre>
      <p className="gs-terminal-output">Hello from GSharp!</p>
      <span className="sr-only" role="status">
        {status === 'copied' ? 'Commands copied to clipboard.' : ''}
      </span>
      {status === 'failed' && (
        <p className="gs-copy-error" role="alert">
          Could not access the clipboard. Select and copy the commands above.
        </p>
      )}
    </div>
  );
}
