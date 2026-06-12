// file: ArrowLambda.gs
// Issue #714 / ADR-0074: demonstrates the new `->` lambda expression
// form. The parameter list is always parenthesized; the body may be a
// single expression or a brace-delimited block whose trailing expression
// becomes the lambda value. Lambdas may capture outer locals and may be
// passed as function-valued arguments.

package GSharp.Example.ArrowLambda

import System

// 1. Single-parameter expression-bodied lambda assigned to a local.
let inc = (x int32) -> x + 1
Console.WriteLine(inc(41))

// 2. Two-parameter expression-bodied lambda.
let add = (a int32, b int32) -> a + b
Console.WriteLine(add(20, 22))

// 3. Zero-parameter lambda. The empty parameter list is required because
//    ADR-0074 deliberately omits the bare-identifier shorthand.
let answer = () -> 42
Console.WriteLine(answer())

// 4. Block-bodied lambda. Statements run for their side effects; the
//    trailing expression becomes the result.
let triple = (x int32) -> {
    let doubled = x * 2
    doubled + x
}
Console.WriteLine(triple(7))

// 5. Capture of outer locals — closure semantics match named func literals.
let base = 100
let offsetFromBase = (x int32) -> base + x
Console.WriteLine(offsetFromBase(5))

// 6. Void-bodied lambda used as a one-off action.
let say = (s string) -> Console.WriteLine(s)
say("hello from a lambda")

// 7. Lambda passed as a function-valued argument.
func apply(f Func[int32, int32], x int32) int32 {
    return f(x)
}
Console.WriteLine(apply((x int32) -> x * x, 6))
