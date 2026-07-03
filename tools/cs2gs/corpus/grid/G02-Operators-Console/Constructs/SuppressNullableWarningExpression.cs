// inventory: SuppressNullableWarningExpression
using System;

namespace Corpus.Grid02
{
    public static class SuppressNullableWarningExpressionFixture
    {
        public static void Run()
        {
            string? maybe = "present";
            string definite = maybe!;
            int len = definite.Length;
            Console.WriteLine($"SuppressNullableWarningExpression: value={definite} len={len}");
        }
    }
}
