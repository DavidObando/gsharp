// inventory: UnsignedRightShiftAssignmentExpression
using System;

namespace Corpus.Grid02
{
    public static class UnsignedRightShiftAssignmentExpressionFixture
    {
        public static void Run()
        {
            int v = 48;
            v >>>= 3;
            int w = -32;
            w >>>= 2;
            Console.WriteLine($"UnsignedRightShiftAssignmentExpression: v={v} w={w}");
        }
    }
}
