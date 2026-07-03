// inventory: AddExpression
using System;

namespace Corpus.Grid02
{
    public static class AddExpressionFixture
    {
        public static void Run()
        {
            int a = 7;
            int b = 3;
            double x = 1.25;
            double y = 2.25;
            string left = "cat";
            string joined = left + "-dog";
            string mixed = "n=" + a;
            Console.WriteLine($"AddExpression: int={a + b} double={x + y}");
            Console.WriteLine($"AddExpression: string={joined} mixed={mixed}");
        }
    }
}
