// inventory: GreaterThanOrEqualExpression
using System;

namespace Corpus.Grid02
{
    public static class GreaterThanOrEqualExpressionFixture
    {
        public static void Run()
        {
            int a = 5;
            int b = 5;
            bool ge = a >= b;
            bool notGe = a >= b + 1;
            Console.WriteLine($"GreaterThanOrEqualExpression: ge={ge} notGe={notGe}");
        }
    }
}
