// inventory: UnsignedRightShiftExpression
using System;

namespace Corpus.Grid02
{
    public static class UnsignedRightShiftExpressionFixture
    {
        public static void Run()
        {
            int value = 32;
            int negative = -8;
            long negativeLong = -8L;
            uint unsignedValue = 4294967288u;
            Console.WriteLine($"UnsignedRightShiftExpression: a={value >>> 2} logical={negative >>> 1} arithmetic={negative >> 1} long={negativeLong >>> 1} uint={unsignedValue >>> 1}");
        }
    }
}
