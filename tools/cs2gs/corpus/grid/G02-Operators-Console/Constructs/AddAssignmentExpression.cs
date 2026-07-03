// inventory: AddAssignmentExpression
using System;

namespace Corpus.Grid02
{
    public static class AddAssignmentExpressionFixture
    {
        public static void Run()
        {
            int n = 10;
            n += 5;
            double d = 1.5;
            d += 2.25;
            string s = "ab";
            s += "cd";
            Console.WriteLine($"AddAssignmentExpression: int={n} double={d} string={s}");
        }
    }
}
