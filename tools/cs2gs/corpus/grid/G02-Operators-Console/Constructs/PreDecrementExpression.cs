// inventory: PreDecrementExpression
using System;

namespace Corpus.Grid02
{
    public static class PreDecrementExpressionFixture
    {
        public static void Run()
        {
            int n = 5;
            int observed = --n;
            Console.WriteLine($"PreDecrementExpression: observed={observed} after={n}");
        }
    }
}
