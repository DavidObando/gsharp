// inventory: ForEachStatement — await foreach over an async iterator (IAsyncEnumerable<int>)
// An async iterator (async + yield return) consumed by `await foreach`. Every
// awaited task is already completed, so iteration order and output are fixed.
using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Corpus.Grid10.Constructs
{
    public static class ForEachStatementFixture
    {
        public static async Task RunAsync()
        {
            int total = 0;
            await foreach (int square in SquaresAsync(4))
            {
                total += square;
                Console.WriteLine($"ForEachStatement: square={square}");
            }

            Console.WriteLine($"ForEachStatement: total={total}");
        }

        private static async IAsyncEnumerable<int> SquaresAsync(int upTo)
        {
            for (int i = 1; i <= upTo; i++)
            {
                await Task.CompletedTask;
                yield return i * i;
            }
        }
    }
}
