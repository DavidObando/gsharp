// inventory: DivideAssignmentExpression
using System;

namespace Corpus.Grid02
{
    public static class DivideAssignmentExpressionFixture
    {
        public static void Run()
        {
            int n = 29;
            n /= 4;
            double d = 9.0;
            d /= 4.0;
            Console.WriteLine($"DivideAssignmentExpression: int={n} double={d}");
        }
    }
}
