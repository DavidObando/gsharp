// inventory: FixedStatement
// `fixed` over an int[] (pointer arithmetic reads plus a write-through) and
// over a string (reading the first character).
using System;

namespace Corpus.Grid12.Constructs
{
    public static class FixedStatementFixture
    {
        public static void Run()
        {
            int[] numbers = new int[] { 3, 5, 7, 11 };
            unsafe
            {
                fixed (int* p = numbers)
                {
                    // NOTE: `sum += *(p + i);` is avoided on purpose — gsc
                    // rejects the emitted `*(p + i)` with GS0129 "Binary
                    // operator '+=' is not defined for types 'int32' and
                    // '**int32'" (deref of a parenthesized pointer-arithmetic
                    // expression misbinds). Pointer element access `p[i]` and
                    // a hoisted `int* q = p + i` both compile and cover the
                    // same reads.
                    int sum = 0;
                    for (int i = 0; i < numbers.Length; i++)
                    {
                        sum += p[i];
                    }

                    Console.WriteLine($"FixedStatement: sum={sum}");

                    int* q = p + 2;
                    Console.WriteLine($"FixedStatement: third={*q}");
                    *p = 42;
                }
            }

            Console.WriteLine($"FixedStatement: first={numbers[0]}");

            string text = "abc";
            unsafe
            {
                fixed (char* c = text)
                {
                    Console.WriteLine($"FixedStatement: firstChar={*c}");
                }
            }
        }
    }
}
