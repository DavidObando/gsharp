// inventory: AnonymousObjectCreationExpression
using System;

namespace Corpus.Grid05
{
    public static class AnonymousObjectCreationExpressionFixture
    {
        public static void Run()
        {
            // G# has no anonymous types; `new { ... }` lowers to the same
            // positional tuple literal as a C# named tuple (issue #1934). G#
            // tuples require at least two elements (gsc rejects 1-tuples), so
            // a single-member anonymous object has no valid tuple lowering;
            // only 2+-member anonymous objects are representative fixtures.
            var pair = new { A = 2, B = "two" };
            Console.WriteLine($"AnonymousObjectCreationExpression: pair={pair.A},{pair.B}");
        }
    }
}
