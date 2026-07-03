// inventory: LeftShiftExpression
using System;

namespace Corpus.Grid02
{
    public static class LeftShiftExpressionFixture
    {
        public static void Run()
        {
            int one = 1;
            int three = 3;
            Console.WriteLine($"LeftShiftExpression: a={one << 5} b={three << 2}");
        }
    }
}
