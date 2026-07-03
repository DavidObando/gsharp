// inventory: GreaterThanExpression
using System;

namespace Corpus.Grid02
{
    public static class GreaterThanExpressionFixture
    {
        public static void Run()
        {
            int a = 8;
            int b = 3;
            bool gt = a > b;
            bool notGt = b > a;
            Console.WriteLine($"GreaterThanExpression: gt={gt} notGt={notGt}");
        }
    }
}
