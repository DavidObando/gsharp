// inventory: ElementBindingExpression
using System;

namespace Corpus.Grid02
{
    public static class ElementBindingExpressionFixture
    {
        public static void Run()
        {
            int[]? numbers = new int[] { 10, 20, 30 };
            int[]? empty = null;
            int first = numbers?[0] ?? -1;
            int missing = empty?[0] ?? -1;
            Console.WriteLine($"ElementBindingExpression: first={first} missing={missing}");
        }
    }
}
