// inventory: PostIncrementExpression
using System;

namespace Corpus.Grid02
{
    public static class PostIncrementExpressionFixture
    {
        public static void Run()
        {
            int n = 5;
            int observed = n++;
            Console.WriteLine($"PostIncrementExpression: observed={observed} after={n}");
        }
    }
}
