// G10-Async-Console: async/await construct grid fixtures (ADR-0115).
// One construct per Constructs/<Kind>.cs file; fixtures run sequentially in
// file-name order and print deterministic, prefix-tagged lines. All awaited
// tasks are already completed — no timing, no thread ids, no races.
using System;
using System.Threading.Tasks;
using Corpus.Grid10.Constructs;

namespace Corpus.Grid10
{
    internal static class Program
    {
        // QUARANTINED (app-level): `async Task Main()`. The translator lowers
        // it to G# top-level `await` statements, and gsc then emits an entry
        // point that returns Task — the CLR aborts at startup with
        // System.MethodAccessException: "Entry point must have a return type
        // of void, integer, or unsigned integer." (stage 4: expected line 1
        // 'AwaitExpression: direct=21', got ''). A synchronous Main that
        // blocks on one async helper keeps every fixture's awaits intact.
        private static void Main()
        {
            RunAllAsync().GetAwaiter().GetResult();
        }

        private static async Task RunAllAsync()
        {
            await AwaitExpressionFixture.RunAsync();
            await AwaitExpressionConfigureAwaitFixture.RunAsync();
            await AwaitExpressionValueTaskFixture.RunAsync();
            await AwaitExpressionWhenAllFixture.RunAsync();
            await ForEachStatementFixture.RunAsync();
            await SimpleLambdaExpressionFixture.RunAsync();
            await TryStatementFixture.RunAsync();

            // QUARANTINED: UsingStatement (await using over IAsyncDisposable).
            // cs2gs lowers `await using` to a plain G# `using`, and gsc then
            // fails with GS0119: "Type 'AsyncResource' cannot be used in a
            // 'using' statement because it does not provide a public Dispose()
            // method." See Constructs/UsingStatement.cs.quarantined.
            // await UsingStatementFixture.RunAsync();
        }
    }
}
