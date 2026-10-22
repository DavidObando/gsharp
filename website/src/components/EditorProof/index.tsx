import type {ReactNode} from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import capture from '@site/static/img/trail-editor.json';
import release from '@site/src/data/release.json';

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
          Historical capture: {capture.editor}, extension {capture.extension}, application SDK{' '}
          {capture.applicationSdk}, {capture.sdk}. These original pixels document the 0.4 project,
          not a current editor verification. The current download is independently executed with
          G# SDK {release.version}.
        </figcaption>
      </figure>
      <details>
        <summary>See the historical 0.4 project running</summary>
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
            Historical terminal output from <code>dotnet run --no-build -- demo .txt</code> with
            application SDK {capture.applicationSdk}, not a simulated console or a new release capture.
          </figcaption>
        </figure>
      </details>
    </div>
  );
}
