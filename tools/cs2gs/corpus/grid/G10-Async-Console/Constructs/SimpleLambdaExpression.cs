// inventory: SimpleLambdaExpression — async lambdas (simple and parenthesized forms)
// Async lambdas stored in Func<...> delegates: an expression-bodied simple
// lambda, a block-bodied parenthesized lambda, and a zero-parameter async
// lambda returning Task. All are invoked and awaited sequentially.
using System;
using System.Threading.Tasks;

namespace Corpus.Grid10.Constructs
{
    public static class SimpleLambdaExpressionFixture
    {
        public static async Task RunAsync()
        {
            Func<int, Task<int>> twice = async x => await Task.FromResult(x * 2);
            int doubled = await twice(15);
            Console.WriteLine($"SimpleLambdaExpression: doubled={doubled}");

            Func<int, int, Task<int>> combine = async (a, b) =>
            {
                int left = await Task.FromResult(a);
                int right = await Task.FromResult(b);
                return left + right;
            };
            int combined = await combine(19, 23);
            Console.WriteLine($"SimpleLambdaExpression: combined={combined}");

            Func<Task> announce = async () =>
            {
                await Task.CompletedTask;
                Console.WriteLine("SimpleLambdaExpression: zero-arg async lambda ran");
            };
            await announce();
        }
    }
}
