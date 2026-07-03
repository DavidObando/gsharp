// inventory: LessThanExpression
using System;

namespace Corpus.Grid02
{
    public static class LessThanExpressionFixture
    {
        public static void Run()
        {
            int a = 2;
            int b = 9;
            bool lt = a < b;
            bool notLt = b < a;
            Console.WriteLine($"LessThanExpression: lt={lt} notLt={notLt}");
        }
    }
}
