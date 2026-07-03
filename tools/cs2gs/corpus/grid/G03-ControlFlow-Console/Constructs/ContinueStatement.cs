// inventory: ContinueStatement
using System;

namespace Corpus.Grid03.Constructs
{
    public static class ContinueStatementFixture
    {
        public static void Run()
        {
            int sumOfOdds = 0;
            for (int i = 1; i <= 10; i++)
            {
                if (i % 2 == 0)
                {
                    continue;
                }

                sumOfOdds += i;
            }

            Console.WriteLine($"ContinueStatement: sum of odds 1..10 = {sumOfOdds}");

            int w = 0;
            int multiplesOfThree = 0;
            while (w < 9)
            {
                w++;
                if (w % 3 != 0)
                {
                    continue;
                }

                multiplesOfThree++;
            }

            Console.WriteLine($"ContinueStatement: multiples of 3 in 1..9 = {multiplesOfThree}");
        }
    }
}
