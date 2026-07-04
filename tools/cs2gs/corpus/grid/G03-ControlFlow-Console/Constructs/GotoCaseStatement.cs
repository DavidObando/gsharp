// inventory: GotoCaseStatement
using System;

namespace Corpus.Grid03.Constructs
{
    public static class GotoCaseStatementFixture
    {
        public static void Run()
        {
            // `goto case 2;` jumps to case 2's statement list without
            // re-evaluating the switch subject; the trace below proves
            // fall-through and side-effect order are preserved.
            var trace = new System.Collections.Generic.List<string>();
            int value = 1;
            switch (value)
            {
                case 1:
                    trace.Add("case1");
                    goto case 2;
                case 2:
                    trace.Add("case2");
                    break;
                default:
                    trace.Add("default");
                    break;
            }

            Console.WriteLine($"GotoCaseStatement: trace = {string.Join(",", trace)}");
        }
    }
}
