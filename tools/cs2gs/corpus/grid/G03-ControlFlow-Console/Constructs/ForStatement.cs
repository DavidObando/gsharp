// inventory: ForStatement
using System;

namespace Corpus.Grid03.Constructs
{
    public static class ForStatementFixture
    {
        public static void Run()
        {
            int total = 0;
            for (int i = 0, j = 10; i < j; i++, j--)
            {
                total += j - i;
            }

            Console.WriteLine($"ForStatement: converging loop total = {total}");

            int hits = 0;
            for (int i = 0; i < 10; i++)
            {
                if (i % 4 == 1)
                {
                    continue;
                }

                hits++;
            }

            Console.WriteLine($"ForStatement: hits with continue skipping i%4==1 = {hits}");

            int countdown = 0;
            for (int i = 5; i > 0; i--)
            {
                countdown = countdown * 10 + i;
            }

            Console.WriteLine($"ForStatement: countdown digits = {countdown}");
        }
    }
}
