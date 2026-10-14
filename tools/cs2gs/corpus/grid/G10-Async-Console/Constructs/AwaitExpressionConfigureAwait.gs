// inventory: AwaitExpression — ConfigureAwait(false) / ConfiguredTaskAwaitable probe
// Awaiting ConfiguredTaskAwaitable / ConfiguredTaskAwaitable<T>. The tasks are
// already completed, so continuation scheduling cannot introduce nondeterminism.

package Corpus.Grid10.Constructs

import System
import System.Threading.Tasks

shared class AwaitExpressionConfigureAwaitFixture {
    async func RunAsync() {
        let value = await Task.FromResult(11).ConfigureAwait(false)
        Console.WriteLine("AwaitExpressionConfigureAwait: value=$value")
        await Task.CompletedTask.ConfigureAwait(false)
        Console.WriteLine("AwaitExpressionConfigureAwait: void-task awaited")
        let chained = await ProduceAsync().ConfigureAwait(false) + 1
        Console.WriteLine("AwaitExpressionConfigureAwait: chained=$chained")
    }

    private async func ProduceAsync() int32 {
        await Task.CompletedTask.ConfigureAwait(false)
        return 41
    }
}
