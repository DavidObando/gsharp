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

            // QUARANTINED (runtime divergence): a System.Index local
            // (Index third = ^3; a[third]) is emitted as 'let third = ^3'
            // followed by 'a[third]', which throws IndexOutOfRangeException
            // at runtime in the translated program. Inline a[^n] works.
            string word = "gsharp";
            Console.WriteLine($"IndexExpression: lastChar={word[^1]}");
        }
    }
}
