// inventory: ArrayCreationExpression
using System;

namespace Corpus.Grid05
{
    public static class ArrayCreationExpressionFixture
    {
        public static void Run()
        {
            int[] sized = new int[3];
            sized[0] = 10;
            sized[1] = 20;
            sized[2] = 30;
            Console.WriteLine($"ArrayCreationExpression: sized={string.Join(",", sized)}");

            string[] words = new string[2];
            words[0] = "alpha";
            words[1] = "beta";
            Console.WriteLine($"ArrayCreationExpression: words={string.Join(",", words)}");

            int[][] jagged = new int[2][];
            jagged[0] = new int[2];
            jagged[0][0] = 1;
            jagged[0][1] = 2;
            jagged[1] = new int[3];
            jagged[1][0] = 3;
            jagged[1][1] = 4;
            jagged[1][2] = 5;
            Console.WriteLine($"ArrayCreationExpression: jagged0={string.Join(",", jagged[0])} jagged1={string.Join(",", jagged[1])}");

            int[] withInit = new int[3] { 7, 8, 9 };
            Console.WriteLine($"ArrayCreationExpression: withInit={string.Join(",", withInit)}");
        }
    }
}
