// inventory: ConditionalAccessExpression
using System;

namespace Corpus.Grid02
{
    public static class ConditionalAccessExpressionFixture
    {
        public static void Run()
        {
            string? word = "hello";
            string? nothing = null;
            int len = word?.Length ?? -1;
            int nullLen = nothing?.Length ?? -1;
            Console.WriteLine($"ConditionalAccessExpression: len={len} nullLen={nullLen}");
        }
    }
}
