// inventory: BreakStatement
using System;

namespace Corpus.Grid03.Constructs
{
    public static class BreakStatementFixture
    {
        public static void Run()
        {
            int firstMultipleOfSeven = -1;
            for (int i = 30; i < 60; i++)
            {
                if (i % 7 == 0)
                {
                    firstMultipleOfSeven = i;
                    break;
                }
            }

            Console.WriteLine($"BreakStatement: first multiple of 7 in [30,60) = {firstMultipleOfSeven}");

            int n = 0;
            while (true)
            {
                n++;
                if (n == 5)
                {
                    break;
                }
            }

            Console.WriteLine($"BreakStatement: while-true exited at n = {n}");
        }
    }
}
