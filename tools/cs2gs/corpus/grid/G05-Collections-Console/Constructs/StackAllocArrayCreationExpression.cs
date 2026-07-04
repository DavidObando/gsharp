// inventory: StackAllocArrayCreationExpression. Covers both the explicit
// sized form ('stackalloc int[4]') and the implicit form
// ('stackalloc[] { 5, 6, 7 }', issue #1897 — was CS2GS-GAP
// "ImplicitStackAllocArrayCreationExpression has no canonical G# form yet";
// now maps to the same G# count-inferred stackalloc initializer as the
// explicit omitted-size form). `stackalloc` lowers to CIL 'localloc', which
// gsc's emitter marks unverifiable by design (a real, tracked gsc emitter
// gap, issue #1933) — G05 opts into the 'ilverify.allow-unsafe' marker so
// this app's stage 3 (ilverify) treats that as expected rather than gating.
using System;

namespace Corpus.Grid05
{
    public static class StackAllocArrayCreationExpressionFixture
    {
        public static void Run()
        {
            Span<int> s = stackalloc int[4];
            for (int i = 0; i < s.Length; i++)
            {
                s[i] = (i + 1) * 10;
            }

            int sum = 0;
            for (int i = 0; i < s.Length; i++)
            {
                sum += s[i];
            }

            Console.WriteLine($"StackAllocArrayCreationExpression: sum={sum} len={s.Length}");

            // ImplicitStackAllocArrayCreationExpression.
            Span<int> t = stackalloc[] { 5, 6, 7 };
            Console.WriteLine($"StackAllocArrayCreationExpression: implicit={t[0]},{t[1]},{t[2]}");
        }
    }
}
