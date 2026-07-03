// inventory: BitwiseAndExpression
using System;

namespace Corpus.Grid02
{
    public static class BitwiseAndExpressionFixture
    {
        public static void Run()
        {
            int a = 12;
            int b = 10;
            bool p = true;
            bool q = false;
            Console.WriteLine($"BitwiseAndExpression: int={a & b} bool={p & q}");
        }
    }
}
