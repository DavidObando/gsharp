// inventory: LessThanOrEqualExpression
using System;

namespace Corpus.Grid02
{
    public static class LessThanOrEqualExpressionFixture
    {
        public static void Run()
        {
            int a = 5;
            int b = 5;
            bool le = a <= b;
            bool notLe = b + 1 <= a;
            Console.WriteLine($"LessThanOrEqualExpression: le={le} notLe={notLe}");
        }
    }
}
