// inventory: LogicalNotExpression
using System;

namespace Corpus.Grid02
{
    public static class LogicalNotExpressionFixture
    {
        public static void Run()
        {
            bool on = true;
            bool off = !on;
            bool doubled = !!on;
            Console.WriteLine($"LogicalNotExpression: off={off} doubled={doubled}");
        }
    }
}
