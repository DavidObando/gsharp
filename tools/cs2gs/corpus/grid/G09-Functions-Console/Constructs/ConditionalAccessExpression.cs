// inventory: ConditionalAccessExpression
using System;

namespace Corpus.Grid09
{
    public static class ConditionalAccessExpressionFixture
    {
        public static void Run()
        {
            Action<string>? handler = null;
            handler?.Invoke("never-printed");
            Console.WriteLine($"ConditionalAccessExpression: nullHandler={(handler == null ? "null" : "set")}");

            // Note: plain concatenation (not interpolation) inside the lambda —
            // the gsc emitter cannot yet emit InterpolatedStringExpression
            // inside lambda bodies (GS9998).
            handler = s => Console.WriteLine("ConditionalAccessExpression: got " + s);
            handler?.Invoke("ping");

            Func<int, int>? square = null;
            int? missed = square?.Invoke(3);
            Console.WriteLine($"ConditionalAccessExpression: missed={(missed.HasValue ? missed.Value.ToString() : "none")}");

            square = x => x * x;
            int? hit = square?.Invoke(3);
            Console.WriteLine($"ConditionalAccessExpression: hit={(hit.HasValue ? hit.Value.ToString() : "none")}");
        }
    }
}
