// inventory: ImplicitArrayCreationExpression
using System;

namespace Corpus.Grid05
{
    public static class ImplicitArrayCreationExpressionFixture
    {
        public static void Run()
        {
            var nums = new[] { 3, 1, 2 };
            Console.WriteLine($"ImplicitArrayCreationExpression: nums={string.Join(",", nums)} len={nums.Length}");

            var strs = new[] { "pico", "nano" };
            Console.WriteLine($"ImplicitArrayCreationExpression: strs={string.Join(",", strs)}");

            var wide = new[] { 1L, 2, 3 };
            Console.WriteLine($"ImplicitArrayCreationExpression: wideSum={wide[0] + wide[1] + wide[2]}");
        }
    }
}
