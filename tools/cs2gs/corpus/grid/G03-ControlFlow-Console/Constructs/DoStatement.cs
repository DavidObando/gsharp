// inventory: DoStatement
using System;

namespace Corpus.Grid03.Constructs
{
    public static class DoStatementFixture
    {
        public static void Run()
        {
            int n = 1;
            int steps = 0;
            do
            {
                n = n * 2;
                steps++;
            }
            while (n < 100);

            Console.WriteLine($"DoStatement: doubled to {n} in {steps} steps");

            int k = 10;
            do
            {
                Console.WriteLine($"DoStatement: body runs at least once, k = {k}");
                k++;
            }
            while (k < 5);

            Console.WriteLine($"DoStatement: after loop k = {k}");
        }
    }
}
