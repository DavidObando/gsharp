// inventory: MultiplyAssignmentExpression
using System;

namespace Corpus.Grid02
{
    public static class MultiplyAssignmentExpressionFixture
    {
        public static void Run()
        {
            int n = 6;
            n *= 7;
            double d = 1.5;
            d *= 4.0;
            Console.WriteLine($"MultiplyAssignmentExpression: int={n} double={d}");
        }
    }
}
