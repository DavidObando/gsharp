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
                    // Issue #1925 (fixed): `sum += *(p + i);` used to be
                    // rejected with GS0129 "Binary operator '+=' is not
                    // defined for types 'int32' and '**int32'" — the
                    // dereference of a parenthesized pointer-arithmetic
                    // expression misbound its RHS as a pointer-to-pointer.
                    // Pointer element access `p[i]` and a hoisted
                    // `int* q = p + i` cover the same reads; this exercises
                    // the direct `*(p + i)` shape too.
                    int sum = 0;
                    for (int i = 0; i < numbers.Length; i++)
                    {
                        sum += *(p + i);
                    }

                    Console.WriteLine($"FixedStatement: sum={sum}");

                    int* q = p + 2;
                    Console.WriteLine($"FixedStatement: third={*q}");
                    *p = 42;

                    // Issue #1925 (fixed): compound assignment through a
                    // parenthesized pointer-arithmetic dereference target
                    // (`*(p + i) += v`) now parses and binds.
                    *(p + 1) += 100;
                    Console.WriteLine($"FixedStatement: secondPlusHundred={numbers[1]}");
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

