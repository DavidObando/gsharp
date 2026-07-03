// inventory: AwaitExpression — Task.WhenAll deterministic composition
// Composes already-completed tasks with Task.WhenAll and prints the results in
// array order (WhenAll preserves input order), so output is deterministic.
using System;
using System.Threading.Tasks;

namespace Corpus.Grid10.Constructs
{
    public static class AwaitExpressionWhenAllFixture
    {
        public static async Task RunAsync()
        {
            // NOTE: an explicit Task<int>[] array literal is avoided on purpose —
            // the generic-element array creation (`new Task<int>[] { ... }`) is a
            // separate construct that currently fails G# round-trip parsing
            // (GS0005 on `[]Task[int32]{...}`). WhenAll's params form still
            // exercises the deterministic composition.
            Task<int> first = Task.FromResult(1);
            Task<int> second = Task.FromResult(4);
            Task<int> third = Task.FromResult(9);

            int[] results = await Task.WhenAll(first, second, third);
            int total = 0;
            for (int i = 0; i < results.Length; i++)
            {
                total += results[i];
                Console.WriteLine($"AwaitExpressionWhenAll: result[{i}]={results[i]}");
            }

            Console.WriteLine($"AwaitExpressionWhenAll: total={total}");

            await Task.WhenAll(Task.CompletedTask, Task.CompletedTask);
            Console.WriteLine("AwaitExpressionWhenAll: void WhenAll done");
        }
    }
}
