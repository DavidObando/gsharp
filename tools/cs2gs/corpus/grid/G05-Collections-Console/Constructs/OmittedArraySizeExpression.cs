// inventory: OmittedArraySizeExpression
using System;

namespace Corpus.Grid05
{
    public static class OmittedArraySizeExpressionFixture
    {
        public static void Run()
        {
            int[] xs = new int[] { 1, 2, 3 };
            Console.WriteLine($"OmittedArraySizeExpression: xs={string.Join(",", xs)}");

            string[] ys = new string[] { "solo" };
            Console.WriteLine($"OmittedArraySizeExpression: ys={ys[0]} len={ys.Length}");
        }
    }
}
