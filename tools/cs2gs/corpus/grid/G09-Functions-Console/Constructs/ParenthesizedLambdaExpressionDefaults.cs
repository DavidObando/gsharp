// inventory: ParenthesizedLambdaExpression — C#12 lambda default parameters.
// Issue #1901: a call through the lambda's variable that omits a defaulted
// trailing argument (`f()`) is lowered to materialize that default explicitly
// (`f(10)`) — gsc's own structural function type has no default to fall back
// on for an indirect call, only the lambda's own ParameterSymbol does.
using System;

namespace Corpus.Grid09
{
    public static class ParenthesizedLambdaExpressionDefaultsFixture
    {
        public static void Run()
        {
            // C#12 lambda default parameters probe.
            var f = (int x = 10) => x * 2;
            Console.WriteLine($"ParenthesizedLambdaExpressionDefaults: fDefault={f()} fGiven={f(3)}");

            var g = (int a, int b = 5) => a + b;
            Console.WriteLine($"ParenthesizedLambdaExpressionDefaults: gDefault={g(1)} gGiven={g(1, 2)}");
        }
    }
}
