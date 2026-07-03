// inventory: LeftShiftAssignmentExpression
using System;

namespace Corpus.Grid02
{
    public static class LeftShiftAssignmentExpressionFixture
    {
        public static void Run()
        {
            int v = 3;
            v <<= 4;
            Console.WriteLine($"LeftShiftAssignmentExpression: v={v}");
        }
    }
}
