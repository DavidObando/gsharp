// inventory: CastExpression
using System;

namespace Corpus.Grid02
{
    public static class CastExpressionFixture
    {
        public static void Run()
        {
            double pi = 3.9;
            int truncated = (int)pi;
            int seven = 7;
            double half = (double)seven / 2;
            int code = 66;
            char letter = (char)code;
            int wide = 300;
            byte narrowed = (byte)wide;
            Console.WriteLine($"CastExpression: truncated={truncated} half={half} letter={letter} narrowed={narrowed}");
        }
    }
}
