// inventory: IndexExpression
using System;

namespace Corpus.Grid05
{
    public static class IndexExpressionFixture
    {
        public static void Run()
        {
            int[] a = { 1, 2, 3, 4, 5 };
            Console.WriteLine($"IndexExpression: last={a[^1]} secondLast={a[^2]}");

            // QUARANTINED (loud CS2GS-GAP by design, issue #1894): a
            // System.Index local (Index third = ^3; a[third]) used to be
            // emitted as 'let third = ^3' followed by 'a[third]', which threw
            // IndexOutOfRangeException at runtime in the translated program
            // (a bare '^n' outside an index bracket parses in gsc as
            // one's-complement, not from-end). G# has no System.Index value
            // type to lower this into correctly, so the translator now
            // reports a gap instead of silently miscompiling — this fixture
            // stays quarantined at the Translate stage until G# gains a
            // canonical Index/Range value type. Inline a[^n] is unaffected
            // and continues to work (see above).
            string word = "gsharp";
            Console.WriteLine($"IndexExpression: lastChar={word[^1]}");
        }
    }
}
