// inventory: EqualsExpression
using System;

namespace Corpus.Grid02
{
    public static class EqualsExpressionFixture
    {
        public static void Run()
        {
            int a = 5;
            int b = 5;
            string s = "hi";
            string? t = null;
            bool sameInt = a == b;
            bool sameString = s == "hi";
            bool isNull = t == null;
            Console.WriteLine($"EqualsExpression: ints={sameInt} strings={sameString} nullCheck={isNull}");
        }
    }
}
