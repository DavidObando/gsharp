// inventory: NullLiteralExpression
using System;

namespace Corpus.Grid01
{
    public static class NullLiteralExpressionFixture
    {
        public static void Run()
        {
            string? missing = null;
            object? nothing = null;
            bool isNull = missing == null;
            string shown = missing ?? "null";
            Console.WriteLine($"NullLiteralExpression: isNull={isNull} shown={shown}");
            Console.WriteLine($"NullLiteralExpression: objectIsNull={nothing == null}");
            missing = "assigned";
            Console.WriteLine($"NullLiteralExpression: afterAssign={missing}");
        }
    }
}
