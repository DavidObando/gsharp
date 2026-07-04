// inventory: TupleExpression
using System;
using System.Collections.Generic;

namespace Corpus.Grid05
{
    public static class TupleExpressionFixture
    {
        public static void Run()
        {
            var t = (2, "two");
            Console.WriteLine($"TupleExpression: items={t.Item1},{t.Item2}");

            (int Count, string Name) pair = (Count: 3, Name: "three");
            Console.WriteLine($"TupleExpression: named={pair.Count},{pair.Name}");

            // Deconstruction with var (a, b).
            var (a, b) = t;
            Console.WriteLine($"TupleExpression: deconstructed={a},{b}");

            // QUARANTINED (GS0127): deconstruction-assignment into existing
            // locals ((x, y) = (y, x)) — the translator emits the targets as
            // read-only 'let' bindings, so 'x = __decon0' fails to compile.

            // Nested tuple.
            var nested = ((1, 2), "pair");
            Console.WriteLine($"TupleExpression: nested={nested.Item1.Item1},{nested.Item1.Item2},{nested.Item2}");

            // Issue #1922: foreach over a tuple-deconstructing pattern
            // translates to G#'s first-class `for (a, b) in xs` header.
            var pairs = new List<(string Name, int Score)> { ("alice", 1), ("bob", 2) };
            foreach (var (name, score) in pairs)
            {
                Console.WriteLine($"TupleExpression: foreach={name},{score}");
            }
        }
    }
}
