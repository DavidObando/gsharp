// inventory: SubtractAssignmentExpression
using System;

namespace Corpus.Grid02
{
    public static class SubtractAssignmentExpressionFixture
    {
        public static void Run()
        {
            int n = 10;
            n -= 4;
            double d = 5.5;
            d -= 1.25;
            Console.WriteLine($"SubtractAssignmentExpression: int={n} double={d}");
        }
    }
}
