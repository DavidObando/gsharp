// inventory: NumericLiteralExpression
using System;

namespace Corpus.Grid01
{
    public static class NumericLiteralExpressionFixture
    {
        public static void Run()
        {
            int plain = 42;
            long big = 9_000_000_000L;
            ulong unsignedBig = 18446744073709551615UL;
            uint unsignedInt = 4000000000u;
            int hex = 0xFF;
            int binary = 0b1010_1010;
            int separated = 1_000_000;
            double d = 3.14159;
            float f = 2.5f;
            decimal m = 19.99m;
            double sci = 1.5e3;
            Console.WriteLine($"NumericLiteralExpression: int={plain} long={big} sep={separated}");
            Console.WriteLine($"NumericLiteralExpression: ulong={unsignedBig} uint={unsignedInt}");
            Console.WriteLine($"NumericLiteralExpression: hex={hex} binary={binary}");
            Console.WriteLine($"NumericLiteralExpression: double={d} float={f} sci={sci}");
            Console.WriteLine($"NumericLiteralExpression: decimal={m}");
        }
    }
}
