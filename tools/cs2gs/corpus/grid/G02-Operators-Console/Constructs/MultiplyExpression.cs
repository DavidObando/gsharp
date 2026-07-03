// inventory: MultiplyExpression
using System;

namespace Corpus.Grid02
{
    public static class MultiplyExpressionFixture
    {
        public static void Run()
        {
            int a = 6;
            int b = 7;
            double x = 1.5;
            int negative = -3;
            Console.WriteLine($"MultiplyExpression: int={a * b} double={x * 4.0} negative={negative * 4}");
        }
    }
}
