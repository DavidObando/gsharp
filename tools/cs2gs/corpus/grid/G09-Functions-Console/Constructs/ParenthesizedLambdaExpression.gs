// inventory: ParenthesizedLambdaExpression

package Corpus.Grid09

import System

shared class ParenthesizedLambdaExpressionFixture {
    func Run() {
        // Explicitly typed parameters.
        let add(int32, int32) -> int32 = (a int32, b int32) -> a + b
        Console.WriteLine("ParenthesizedLambdaExpression: add=${add(2, 3)}")
        // Implicitly typed multi-parameter.
        let mul(int32, int32) -> int32 = (a int32, b int32) -> a * b
        Console.WriteLine("ParenthesizedLambdaExpression: mul=${mul(4, 5)}")
        // Zero parameters.
        let hello() -> string = () -> "hello"
        Console.WriteLine("ParenthesizedLambdaExpression: hello=${hello()}")
        // Statement-bodied.
        let stmt(int32) -> int32 = (x int32) -> {
            let tripled = x * 3
            return tripled + 1
        }
        Console.WriteLine("ParenthesizedLambdaExpression: stmt=${stmt(5)}")
        // Statement-bodied Action. Keep interpolation here so the grid
        // catches regressions in nested-body emit lowering (#1928).
        let report(int32, int32) -> void = (a int32, b int32) -> {
            Console.WriteLine("ParenthesizedLambdaExpression: report=$a/$b")
        }
        report(6, 7)
    }
}
