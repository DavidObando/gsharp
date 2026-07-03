// inventory: UnaryPlusExpression
using System;

namespace Corpus.Grid02
{
    public static class UnaryPlusExpressionFixture
    {
        public static void Run()
        {
            int five = 5;
            int plus = +five;
            double d = +2.5;
            Console.WriteLine($"UnaryPlusExpression: plus={plus} double={d}");
        }
    }
}
