// inventory: StackAllocArrayCreationExpression — stackalloc into int* (probe) and into Span<int>
// Unsafe-context stackalloc bound to a pointer (with and without an
// initializer) plus the safe-context Span<int> form.

package Corpus.Grid12.Constructs

import System

shared class StackAllocArrayCreationExpressionFixture {
    func Run() {
        unsafe {
            var s = stackalloc[4]int32
            for var i = 0; i < 4; i++ {
                s[i] = (i + 1) * (i + 1)
            }
            var total = 0
            for var i = 0; i < 4; i++ {
                total += s[i]
            }
            Console.WriteLine("StackAllocArrayCreationExpression: total=$total")
            let init = stackalloc[3]int32{2, 4, 6}
            Console.WriteLine("StackAllocArrayCreationExpression: init1=${init[1]}")
        }
        let span = stackalloc[3]int32{1, 2, 3}
        Console.WriteLine("StackAllocArrayCreationExpression: span2=${span[2]}")
    }
}
