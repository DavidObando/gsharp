// inventory: GotoStatement
using System;

namespace Corpus.Grid03.Constructs
{
    public static class GotoStatementFixture
    {
        public static void Run()
        {
            int count = 0;
        retry:
            count++;
            if (count < 3)
            {
                goto retry;
            }

            Console.WriteLine($"GotoStatement: backward loop finished at count = {count}");

            int step = 0;
            goto skip;
            step = 100;
        skip:
            step += 1;
            Console.WriteLine($"GotoStatement: forward jump left step = {step}");
        }
    }
}
