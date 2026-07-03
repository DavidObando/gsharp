// inventory: AwaitExpression
// Core await coverage: await over already-completed tasks (Task.FromResult /
// Task.CompletedTask), awaits nested inside larger expressions (arithmetic,
// interpolation, argument positions), and async methods returning Task and
// Task<T>. Every await is sequential and deterministic.
using System;
using System.Threading.Tasks;

namespace Corpus.Grid10.Constructs
{
    public static class AwaitExpressionFixture
    {
        public static async Task RunAsync()
        {
            int direct = await Task.FromResult(21);
            Console.WriteLine($"AwaitExpression: direct={direct}");

            int sum = await Task.FromResult(10) + await Task.FromResult(32);
            Console.WriteLine($"AwaitExpression: sum={sum}");

            int nested = await Task.FromResult(await Task.FromResult(7) * 3);
            Console.WriteLine($"AwaitExpression: nested={nested}");

            Console.WriteLine($"AwaitExpression: interpolated={await DoubleAsync(8)}");

            await PrintAsync("helper");

            int viaArg = Add(await Task.FromResult(2), await DoubleAsync(3));
            Console.WriteLine($"AwaitExpression: viaArg={viaArg}");
        }

        private static async Task<int> DoubleAsync(int value)
        {
            int doubled = await Task.FromResult(value * 2);
            return doubled;
        }

        private static async Task PrintAsync(string label)
        {
            await Task.CompletedTask;
            Console.WriteLine($"AwaitExpression: task-returning {label} ran");
        }

        private static int Add(int left, int right)
        {
            return left + right;
        }
    }
}
