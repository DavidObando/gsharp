// inventory: SimpleLambdaExpression
using System;
using System.Linq;

namespace Corpus.Grid09
{
    public static class SimpleLambdaExpressionFixture
    {
        public static void Run()
        {
            Func<int, int> twice = x => x * 2;
            Console.WriteLine($"SimpleLambdaExpression: twice={twice(8)}");

            // Closure over a local.
            int factor = 10;
            Func<int, int> scale = x => x * factor;
            Console.WriteLine($"SimpleLambdaExpression: scale={scale(4)}");

            Func<string, string> bang = s => s + "!";
            Console.WriteLine($"SimpleLambdaExpression: bang={bang("go")}");

            var bumped = new[] { 1, 2, 3 }.Select(x => x + 1);
            Console.WriteLine($"SimpleLambdaExpression: bumped={string.Join(",", bumped)}");
        }
    }
}
