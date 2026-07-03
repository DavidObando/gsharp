// inventory: NotEqualsExpression
using System;

namespace Corpus.Grid02
{
    public static class NotEqualsExpressionFixture
    {
        public static void Run()
        {
            int a = 3;
            int b = 4;
            string s = "a";
            string? t = null;
            bool diffInt = a != b;
            bool diffString = s != "a";
            bool notNull = t != null;
            Console.WriteLine($"NotEqualsExpression: ints={diffInt} strings={diffString} notNull={notNull}");
        }
    }
}
