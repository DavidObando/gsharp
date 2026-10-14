// G10-Async-Console: async/await construct grid fixtures (ADR-0115).
// One construct per Constructs/<Kind>.cs file; fixtures run sequentially in
// file-name order and print deterministic, prefix-tagged lines. All awaited
// tasks are already completed — no timing, no thread ids, no races.

package Corpus.Grid10

import Corpus.Grid10.Constructs
import System
import System.Threading.Tasks

await AwaitExpressionFixture.RunAsync()
await AwaitExpressionConfigureAwaitFixture.RunAsync()
await AwaitExpressionValueTaskFixture.RunAsync()
await AwaitExpressionWhenAllFixture.RunAsync()
await ForEachStatementFixture.RunAsync()
await SimpleLambdaExpressionFixture.RunAsync()
await TryStatementFixture.RunAsync()
await UsingStatementFixture.RunAsync()
