// inventory: StackAllocArrayCreationExpression — stackalloc into int* (probe) and into Span<int>
// Unsafe-context stackalloc bound to a pointer (with and without an
// initializer) plus the safe-context Span<int> form.
using System;

namespace Corpus.Grid12.Constructs
{
    public static class StackAllocArrayCreationExpressionFixture
    {
        public static void Run()
        {
            unsafe
            {
                int* s = stackalloc int[4];
                for (int i = 0; i < 4; i++)
                {
                    s[i] = (i + 1) * (i + 1);
                }

                int total = 0;
                for (int i = 0; i < 4; i++)
                {
                    total += s[i];
                }

                Console.WriteLine($"StackAllocArrayCreationExpression: total={total}");

                int* init = stackalloc int[] { 2, 4, 6 };
                Console.WriteLine($"StackAllocArrayCreationExpression: init1={init[1]}");
            }

            Span<int> span = stackalloc int[3] { 1, 2, 3 };
            Console.WriteLine($"StackAllocArrayCreationExpression: span2={span[2]}");
        }
    }
}
