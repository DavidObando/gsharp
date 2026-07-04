// inventory: GotoDefaultStatement
using System;

namespace Corpus.Grid03.Constructs
{
    public static class GotoDefaultStatementFixture
    {
        public static void Run()
        {
            // `goto default;` jumps to the default section's statement list
            // without re-evaluating the switch subject.
            var trace = new System.Collections.Generic.List<string>();
            int value = 7;
            switch (value)
            {
                case 7:
                    trace.Add("case7");
                    goto default;
                default:
                    trace.Add("default");
                    break;
            }

            Console.WriteLine($"GotoDefaultStatement: trace = {string.Join(",", trace)}");
        }
    }
}
