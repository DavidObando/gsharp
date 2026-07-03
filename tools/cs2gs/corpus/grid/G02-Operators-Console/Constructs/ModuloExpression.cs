// inventory: ModuloExpression
using System;

namespace Corpus.Grid02
{
    public static class ModuloExpressionFixture
    {
        public static void Run()
        {
            int a = 7;
            int b = 3;
            int negative = -7;
            double x = 7.5;
            Console.WriteLine($"ModuloExpression: int={a % b} negInt={negative % b} double={x % 2.0}");
        }
    }
}
