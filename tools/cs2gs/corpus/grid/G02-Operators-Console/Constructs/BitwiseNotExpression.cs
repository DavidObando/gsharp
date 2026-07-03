// inventory: BitwiseNotExpression
using System;

namespace Corpus.Grid02
{
    public static class BitwiseNotExpressionFixture
    {
        public static void Run()
        {
            int five = 5;
            int zero = 0;
            Console.WriteLine($"BitwiseNotExpression: notFive={~five} notZero={~zero}");
        }
    }
}
