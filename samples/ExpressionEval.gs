// file: ExpressionEval.gs
//
// Phase 6 exit sample. Builds a tiny expression AST as a sealed interface
// hierarchy and evaluates it through a switch expression with type-pattern
// arms. Exercises Phase 6.1 (switch expression), 6.2 (type patterns),
// 6.3 (sealed-interface exhaustiveness — the switch omits default because
// the binder proves all three implementors are covered), and 6.4
// (Phase 6.4 method-with-receiver form is not used here, but the surface
// composes cleanly with this sample).

package GSharp.Samples.ExpressionEval

import System

type Expr sealed interface {
}

type Lit class : Expr {
    var Value int32
}

type Add class : Expr {
    var Left Expr
    var Right Expr
}

type Mul class : Expr {
    var Left Expr
    var Right Expr
}

func eval(e Expr) int32 {
    return switch e {
        case l is Lit -> l.Value
        case a is Add -> eval(a.Left) + eval(a.Right)
        case m is Mul -> eval(m.Left) * eval(m.Right)
    }
}

// (1 + 2) * (3 + 4) = 21
let expr = Mul{
    Left: Add{Left: Lit{Value: 1}, Right: Lit{Value: 2}},
    Right: Add{Left: Lit{Value: 3}, Right: Lit{Value: 4}},
}

Console.WriteLine(eval(expr))
