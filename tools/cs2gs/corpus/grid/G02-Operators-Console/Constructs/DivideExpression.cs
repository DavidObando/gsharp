// inventory: DivideExpression
using System;

namespace Corpus.Grid02
{
    public static class DivideExpressionFixture
    {
        public static void Run()
        {
            int a = 7;
            int b = 2;
            int negative = -7;
            double x = 7.0;
            Console.WriteLine($"DivideExpression: int={a / b} negInt={negative / b} double={x / b}");
        }
    }
}
