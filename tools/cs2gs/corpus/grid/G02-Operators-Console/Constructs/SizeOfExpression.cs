// inventory: SizeOfExpression
using System;

namespace Corpus.Grid02
{
    public static class SizeOfExpressionFixture
    {
        public static void Run()
        {
            Console.WriteLine($"SizeOfExpression: int={sizeof(int)} byte={sizeof(byte)} char={sizeof(char)}");
            Console.WriteLine($"SizeOfExpression: long={sizeof(long)} bool={sizeof(bool)} double={sizeof(double)}");
        }
    }
}
