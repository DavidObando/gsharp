import type {ReactNode} from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import capture from '@site/static/img/trail-editor.json';

export default function EditorProof(): ReactNode {
  const completion = useBaseUrl('/img/trail-completion.png');
  const output = useBaseUrl('/img/trail-output.png');
  return (
    <div className="gs-editor-proof">
      <figure>
        <a href={completion} target="_blank" rel="noopener noreferrer">
          <img
            src={completion}
            width="1440"
            height="1000"
            loading="lazy"
            alt="Open full-size capture: Trail's G# source in Visual Studio Code with .NET Path method completion open."
          />
        </a>
        <figcaption>
          Actual {capture.editor}, G# extension {capture.applicationSdk}. The editor resolves .NET
          APIs in the runnable Trail project.
        </figcaption>
      </figure>
      <details>
        <summary>See the same project running</summary>
        <figure>
          <a href={output} target="_blank" rel="noopener noreferrer">
            <img
              src={output}
              width="1440"
              height="1000"
              loading="lazy"
              alt="Open full-size capture: Trail running in the VS Code terminal and producing its JSON inventory for the bundled text files."
            />
          </a>
          <figcaption>
            Real terminal output from <code>dotnet run --no-build -- demo .txt</code>, not a
            simulated console.
          </figcaption>
        </figure>
      </details>
    </div>
  );
}
