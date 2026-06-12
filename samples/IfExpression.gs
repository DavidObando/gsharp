// file: IfExpression.gs
// Issue #711 / ADR-0064: demonstrates `if` used as a value-producing
// expression. The form supports a terminal `else` branch (required in
// value position), `else if` chains, multi-statement blocks whose
// trailing expression becomes the block value, and nested if-expressions.
// Each block prints a small, unmistakable line so a reviewer can read the
// golden top-to-bottom and match it against the source.

package GSharp.Example.IfExpression

import System

// 1. Simple two-arm if-expression in a let-initializer. Only the chosen
//    arm is evaluated.
let day = 3
let kind = if day == 0 { "Sunday" } else { "weekday" }
Console.WriteLine(kind)

// 2. else-if chain in value position. The chain is right-associative — the
//    `else if` is a nested if-expression and the terminal `else` makes the
//    chain exhaustive.
func Grade(p int32) string {
    return if p >= 90 { "A" } else if p >= 80 { "B" } else if p >= 70 { "C" } else { "F" }
}

Console.WriteLine(Grade(95))
Console.WriteLine(Grade(85))
Console.WriteLine(Grade(75))
Console.WriteLine(Grade(50))

// 3. Multi-statement block as a branch. The trailing expression is lifted
//    out of the block and becomes the branch value; the preceding
//    statements run for their side effects.
var visits = 0
let title = if visits == 0 {
    visits = visits + 1
    "First visit"
} else {
    "Welcome back"
}
Console.WriteLine(title)
Console.WriteLine(visits)

// 4. Nested if-expressions: the then-branch can itself be an if-expression.
let a = true
let b = false
let n = if a { if b { 1 } else { 2 } } else { 3 }
Console.WriteLine(n)

// 5. If-expression as a call argument. The expression is evaluated to a
//    string and passed straight through.
Console.WriteLine(if visits == 1 { "one visit so far" } else { "many visits" })

// 6. If-expression in a return statement, with nil-aware branches that
//    unify under the common-type rule. The nullable string `opt` flows
//    through one arm and a fresh nullable string flows through the other,
//    so both arms share the same nullable type.
func ChooseLabel(opt string?) string? {
    let fallback string? = nil
    return if opt != nil { opt } else { fallback }
}

let chosen = ChooseLabel("hello")
if let v = chosen {
    Console.WriteLine(v)
} else {
    Console.WriteLine("nil")
}
