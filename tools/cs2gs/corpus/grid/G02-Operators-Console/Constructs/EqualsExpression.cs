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
            // ADR-0171 / issue #3501: tuple equality — element-wise, names ignored.
            (int Line, int Column) pos = (3, 5);
            bool sameTuple = pos == (3, 5);
            bool nestedTuple = ((1, 2), "x") == ((1, 2), "x");
            Console.WriteLine($"EqualsExpression: ints={sameInt} strings={sameString} nullCheck={isNull} tuples={sameTuple} nested={nestedTuple}");
        }
    }
}
