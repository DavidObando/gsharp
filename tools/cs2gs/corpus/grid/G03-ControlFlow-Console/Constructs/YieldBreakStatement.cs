// inventory: YieldBreakStatement
using System;
using System.Collections.Generic;

namespace Corpus.Grid03.Constructs
{
    public static class YieldBreakStatementFixture
    {
        public static void Run()
        {
            int[] values = { 4, 8, 15, -1, 16, 23 };
            foreach (int v in TakeUntilNegative(values))
            {
                Console.WriteLine($"YieldBreakStatement: yielded {v}");
            }

            Console.WriteLine("YieldBreakStatement: iteration stopped at first negative");
        }

        private static IEnumerable<int> TakeUntilNegative(int[] values)
        {
            foreach (int v in values)
            {
                if (v < 0)
                {
                    yield break;
                }

                yield return v;
            }
        }
    }
}
