// inventory: ModuloAssignmentExpression
using System;

namespace Corpus.Grid02
{
    public static class ModuloAssignmentExpressionFixture
    {
        public static void Run()
        {
            int n = 29;
            n %= 4;
            double d = 7.5;
            d %= 2.0;
            Console.WriteLine($"ModuloAssignmentExpression: int={n} double={d}");
        }
    }
}
