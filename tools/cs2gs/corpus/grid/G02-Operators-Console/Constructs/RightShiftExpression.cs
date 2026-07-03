// inventory: RightShiftExpression
using System;

namespace Corpus.Grid02
{
    public static class RightShiftExpressionFixture
    {
        public static void Run()
        {
            int value = 32;
            int negative = -8;
            Console.WriteLine($"RightShiftExpression: a={value >> 2} arithmetic={negative >> 1}");
        }
    }
}
