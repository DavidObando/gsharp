// inventory: ParenthesizedLambdaExpression
using System;

namespace Corpus.Grid09
{
    [AttributeUsage(AttributeTargets.Method)]
    public sealed class TraceMarkerAttribute : Attribute
    {
    }

    public static class ParenthesizedLambdaExpressionAttributedFixture
    {
        public static void Run()
        {
            // C#10 attributed-lambda probe.
            var f = [TraceMarker] (int x) => x + 1;
            Console.WriteLine($"ParenthesizedLambdaExpressionAttributed: result={f(41)}");
        }
    }
}
