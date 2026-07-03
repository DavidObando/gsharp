// inventory: LogicalOrExpression
using System;

namespace Corpus.Grid02
{
    public static class LogicalOrExpressionFixture
    {
        public static void Run()
        {
            string? s = null;
            bool safe = s == null || s.Length > 0;
            bool either = 1 > 2 || 2 > 1;
            Console.WriteLine($"LogicalOrExpression: safe={safe} either={either}");
        }
    }
}
