// inventory: AwaitExpression — ConfigureAwait(false) / ConfiguredTaskAwaitable probe
// Awaiting ConfiguredTaskAwaitable / ConfiguredTaskAwaitable<T>. The tasks are
// already completed, so continuation scheduling cannot introduce nondeterminism.
using System;
using System.Threading.Tasks;

namespace Corpus.Grid10.Constructs
{
    public static class AwaitExpressionConfigureAwaitFixture
    {
        public static async Task RunAsync()
        {
            int value = await Task.FromResult(11).ConfigureAwait(false);
            Console.WriteLine($"AwaitExpressionConfigureAwait: value={value}");

            await Task.CompletedTask.ConfigureAwait(false);
            Console.WriteLine("AwaitExpressionConfigureAwait: void-task awaited");

            int chained = await ProduceAsync().ConfigureAwait(false) + 1;
            Console.WriteLine($"AwaitExpressionConfigureAwait: chained={chained}");
        }

        private static async Task<int> ProduceAsync()
        {
            await Task.CompletedTask.ConfigureAwait(false);
            return 41;
        }
    }
}
