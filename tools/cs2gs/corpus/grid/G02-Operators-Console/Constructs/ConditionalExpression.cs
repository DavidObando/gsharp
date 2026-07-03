// inventory: ConditionalExpression
using System;

namespace Corpus.Grid02
{
    public static class ConditionalExpressionFixture
    {
        public static void Run()
        {
            int a = 6;
            int b = 9;
            int max = a > b ? a : b;
            string label = a % 2 == 0 ? "even" : "odd";
            int clamped = a < 0 ? 0 : (a > 5 ? 5 : a);
            Console.WriteLine($"ConditionalExpression: max={max} label={label} clamped={clamped}");
        }
    }
}
