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
            // ADR-0171 / issue #3501: the self-migration wall shape — a fresh
            // tuple literal `!=` a named-element tuple value.
            (int Line, int Column) expected = (3, 5);
            bool diffTuple = (a, b) != expected;
            Console.WriteLine($"NotEqualsExpression: ints={diffInt} strings={diffString} notNull={notNull} tuples={diffTuple}");
        }
    }
}
