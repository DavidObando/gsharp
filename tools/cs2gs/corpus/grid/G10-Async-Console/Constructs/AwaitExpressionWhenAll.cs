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
            // Issue #1924 (resolved): the generic-element array creation
            // (`new Task<int>[] { ... }`) previously failed G# round-trip
            // parsing (GS0005 on `[]Task[int32]{...}`) because the array-of-
            // generic-element-type literal only handled a bare identifier
            // element and had no way to consume the element's own
            // type-argument list. Now exercised directly alongside WhenAll's
            // params form.
            Task<int>[] tasks = new Task<int>[]
            {
                Task.FromResult(1),
                Task.FromResult(4),
                Task.FromResult(9),
            };

            int[] results = await Task.WhenAll(tasks);
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
