// inventory: SubtractExpression
using System;

namespace Corpus.Grid02
{
    public static class SubtractExpressionFixture
    {
        public static void Run()
        {
            int a = 10;
            int b = 4;
            double x = 2.5;
            double y = 0.25;
            Console.WriteLine($"SubtractExpression: int={a - b} negative={b - a + -1} double={x - y}");
        }
    }
}
