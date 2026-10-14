// inventory: FixedStatement
// `fixed` over an int[] (pointer arithmetic reads plus a write-through) and
// over a string (reading the first character).

package Corpus.Grid12.Constructs

import System

shared class FixedStatementFixture {
    func Run() {
        let numbers = []int32{3, 5, 7, 11}
        unsafe {
            fixed p *int32 = numbers {
                // Issue #1925 (fixed): `sum += *(p + i);` used to be
                // rejected with GS0129 "Binary operator '+=' is not
                // defined for types 'int32' and '**int32'" — the
                // dereference of a parenthesized pointer-arithmetic
                // expression misbound its RHS as a pointer-to-pointer.
                // Pointer element access `p[i]` and a hoisted
                // `int* q = p + i` cover the same reads; this exercises
                // the direct `*(p + i)` shape too.
                var sum = 0
                for var i = 0; i < numbers.Length; i++ {
                    sum += *(p + i)
                }
                Console.WriteLine("FixedStatement: sum=$sum")
                let q = p + 2
                Console.WriteLine("FixedStatement: third=${*q}")
                *p = 42
                // Issue #1925 (fixed): compound assignment through a
                // parenthesized pointer-arithmetic dereference target
                // (`*(p + i) += v`) now parses and binds.
                *(p + 1) += 100
                Console.WriteLine("FixedStatement: secondPlusHundred=${numbers[1]}")
            }
        }
        Console.WriteLine("FixedStatement: first=${numbers[0]}")
        let text = "abc"
        unsafe {
            fixed c *char = text {
                Console.WriteLine("FixedStatement: firstChar=${*c}")
            }
        }
    }
}
