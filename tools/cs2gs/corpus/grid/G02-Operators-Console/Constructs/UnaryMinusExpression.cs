// inventory: UnaryMinusExpression
using System;

namespace Corpus.Grid02
{
    public static class UnaryMinusExpressionFixture
    {
        public static void Run()
        {
            int five = 5;
            int negated = -five;
            double d = -2.5;
            int expr = -(3 + 4);
            Console.WriteLine($"UnaryMinusExpression: negated={negated} double={d} expr={expr}");
        }
    }
}
