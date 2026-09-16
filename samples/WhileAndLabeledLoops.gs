// file: WhileAndLabeledLoops.gs
// ADR-0070 / issue #707: demonstrates the `while`, `do`-`while`, and
// labeled `break` / `continue` forms that were added on top of the
// existing `for` family. Each block prints a small, unmistakable line
// so a reviewer can read the golden top-to-bottom and match it against
// the source.

package GSharp.Example.WhileAndLabeledLoops

import System

// 1. Plain `while` — pre-test loop, alias for `for cond { … }`.
var i = 0
while i < 3 {
    Console.WriteLine("while $i")
    i = i + 1
}

// 2. `do { … } while cond` — post-test loop. Body always runs once,
// even when the condition is initially false.
var j = 5
do {
    Console.WriteLine("do-while $j")
    j = j + 1
} while j < 5

// 3. Labeled `break` — escape a nested loop from the inner body.
var firstHit = ""
outer: for var x = 0; x < 4; x++ {
    for var y = 0; y < 4; y++ {
        if x * y == 6 {
            firstHit = "x=$x,y=$y"
            break outer
        }
    }
}

Console.WriteLine("first product-6 hit: $firstHit")

// 4. Labeled `continue` — skip the rest of the inner body and resume
// the outer loop's next iteration.
skip: for var n = 0; n < 3; n++ {
    for var m = 0; m < 3; m++ {
        if m == 1 {
            continue skip
        }

        Console.WriteLine("kept n=$n m=$m")
    }
}

// 5. `do`-`while` with an unlabeled inner `break` — the inner break
// targets the innermost loop, leaving the do-while running.
var k = 0
do {
    for var s = 0; s < 5; s++ {
        if s == 2 {
            break
        }

        Console.WriteLine("inner $s (k=$k)")
    }

    k = k + 1
} while k < 2
