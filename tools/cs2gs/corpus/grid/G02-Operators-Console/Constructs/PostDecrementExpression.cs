// inventory: PostDecrementExpression
using System;

namespace Corpus.Grid02
{
    public static class PostDecrementExpressionFixture
    {
        public static void Run()
        {
            int n = 5;
            int observed = n--;
            Console.WriteLine($"PostDecrementExpression: observed={observed} after={n}");
        }
    }
}
