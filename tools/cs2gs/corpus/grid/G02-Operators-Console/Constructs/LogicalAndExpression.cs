// inventory: LogicalAndExpression
using System;

namespace Corpus.Grid02
{
    public static class LogicalAndExpressionFixture
    {
        public static void Run()
        {
            string? s = null;
            bool guarded = s != null && s.Length > 0;
            bool both = 2 < 3 && 3 < 4;
            Console.WriteLine($"LogicalAndExpression: guarded={guarded} both={both}");
        }
    }
}
