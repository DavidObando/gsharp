// inventory: PreIncrementExpression
using System;

namespace Corpus.Grid02
{
    public static class PreIncrementExpressionFixture
    {
        public static void Run()
        {
            int n = 5;
            int observed = ++n;
            Console.WriteLine($"PreIncrementExpression: observed={observed} after={n}");
        }
    }
}
