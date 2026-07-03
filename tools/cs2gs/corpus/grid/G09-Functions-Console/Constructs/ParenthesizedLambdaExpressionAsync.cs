// inventory: ParenthesizedLambdaExpression
using System;
using System.Threading.Tasks;

namespace Corpus.Grid09
{
    public static class ParenthesizedLambdaExpressionAsyncFixture
    {
        public static void Run()
        {
            // Async lambda probe; awaits an already-completed task so the
            // result is synchronous and deterministic.
            Func<Task<int>> f = async () =>
            {
                int forty = await Task.FromResult(40);
                return forty + 2;
            };
            Console.WriteLine($"ParenthesizedLambdaExpressionAsync: result={f().GetAwaiter().GetResult()}");
        }
    }
}
