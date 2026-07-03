// inventory: BitwiseOrExpression
using System;

namespace Corpus.Grid02
{
    public static class BitwiseOrExpressionFixture
    {
        public static void Run()
        {
            int a = 12;
            int b = 10;
            bool p = true;
            bool q = false;
            Console.WriteLine($"BitwiseOrExpression: int={a | b} bool={p | q}");
        }
    }
}
