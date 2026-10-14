// inventory: ParenthesizedLambdaExpression — C#12 lambda default parameters.
// Issue #1901: a call through the lambda's variable that omits a defaulted
// trailing argument (`f()`) is lowered to materialize that default explicitly
// (`f(10)`) — gsc's own structural function type has no default to fall back
// on for an indirect call, only the lambda's own ParameterSymbol does.

package Corpus.Grid09

import System

shared class ParenthesizedLambdaExpressionDefaultsFixture {
    func Run() {
        // C#12 lambda default parameters probe.
        let f = (x int32 = 10) -> x * 2
        Console.WriteLine("ParenthesizedLambdaExpressionDefaults: fDefault=${f(10)} fGiven=${f(3)}")
        let g = (a int32, b int32 = 5) -> a + b
        Console.WriteLine("ParenthesizedLambdaExpressionDefaults: gDefault=${g(1, 5)} gGiven=${g(1, 2)}")
    }
}
