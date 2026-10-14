// inventory: ForEachStatement — await foreach over an async iterator (IAsyncEnumerable<int>)
// An async iterator (async + yield return) consumed by `await foreach`. Every
// awaited task is already completed, so iteration order and output are fixed.

package Corpus.Grid10.Constructs

import System
import System.Collections.Generic
import System.Threading.Tasks

shared class ForEachStatementFixture {
    async func RunAsync() {
        var total = 0
        await for square in SquaresAsync(4) {
            total += square
            Console.WriteLine("ForEachStatement: square=$square")
        }
        Console.WriteLine("ForEachStatement: total=$total")
    }

    private async func SquaresAsync(upTo int32) IAsyncEnumerable[int32] {
        for var i = 1; i <= upTo; i++ {
            await Task.CompletedTask
            yield i * i
        }
    }
}
