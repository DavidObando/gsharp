// inventory: RefExpression — issue #1900: ref locals aliasing an array
// element and a plain local: 'ref int r = ref xs[1]', 'ref int alias = ref v'.
// Maps to G#'s native ref-aliasing local (`let/var ref name T = lvalue`,
// issue #491/ADR-0060) so writes through the alias observably hit the
// original storage. See Quarantined/RefExpressionLocalFunction.cs.txt for the
// ref-returning-local-function/re-alias shapes that have no native G# form.
using System;

namespace Corpus.Grid09
{
    public static class RefExpressionFixture
    {
        public static void Run()
        {
            int[] xs = { 1, 2, 3 };

            // Ref local aliasing an array element.
            ref int r = ref xs[1];
            r = 20;
            Console.WriteLine($"RefExpression: xs={string.Join(",", xs)}");

            int v = 5;
            ref int alias = ref v;
            alias = 6;
            Console.WriteLine($"RefExpression: v={v}");
        }
    }
}
