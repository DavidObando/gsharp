// inventory: SizeOfExpression
// sizeof over primitives (safe context) and over a user struct (unsafe
// context). All sizes are fixed by the CLI spec / sequential layout.
using System;

namespace Corpus.Grid12.Constructs
{
    internal struct SizePair
    {
        public int A;
        public int B;
    }

    public static class SizeOfExpressionFixture
    {
        public static void Run()
        {
            Console.WriteLine($"SizeOfExpression: sizeof(byte)={sizeof(byte)}");
            Console.WriteLine($"SizeOfExpression: sizeof(short)={sizeof(short)}");
            Console.WriteLine($"SizeOfExpression: sizeof(int)={sizeof(int)}");
            Console.WriteLine($"SizeOfExpression: sizeof(long)={sizeof(long)}");
            Console.WriteLine($"SizeOfExpression: sizeof(char)={sizeof(char)}");
            Console.WriteLine($"SizeOfExpression: sizeof(double)={sizeof(double)}");

            SizePair pair;
            pair.A = 3;
            pair.B = 4;
            unsafe
            {
                Console.WriteLine($"SizeOfExpression: sizeof(SizePair)={sizeof(SizePair)} sum={pair.A + pair.B}");
            }
        }
    }
}
