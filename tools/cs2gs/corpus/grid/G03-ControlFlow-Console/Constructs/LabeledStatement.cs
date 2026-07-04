// inventory: LabeledStatement
using System;

namespace Corpus.Grid03.Constructs
{
    public static class LabeledStatementFixture
    {
        public static void Run()
        {
            // A label on a non-loop statement (ADR-0070 generalized by
            // ADR-0139) is a valid goto target; here it also just labels an
            // ordinary statement with nothing jumping to it, exercising the
            // labeled-statement form on its own.
            int total = 0;
        addOne:
            total += 1;
            if (total < 3)
            {
                goto addOne;
            }

            Console.WriteLine($"LabeledStatement: total = {total}");
        }
    }
}
