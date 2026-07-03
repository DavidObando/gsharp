// inventory: ArrayInitializerExpression
using System;

namespace Corpus.Grid05
{
    public static class ArrayInitializerExpressionFixture
    {
        public static void Run()
        {
            int[] xs = { 1, 2, 3 };
            Console.WriteLine($"ArrayInitializerExpression: xs={string.Join(",", xs)}");

            string[] names = { "north", "south" };
            Console.WriteLine($"ArrayInitializerExpression: names={string.Join(",", names)}");

            int[] single = { 42 };
            Console.WriteLine($"ArrayInitializerExpression: single={single[0]} len={single.Length}");
        }
    }
}
