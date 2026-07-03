// inventory: AnonymousObjectCreationExpression
using System;

namespace Corpus.Grid05
{
    public static class AnonymousObjectCreationExpressionFixture
    {
        public static void Run()
        {
            // G# has no anonymous types; `new { ... }` lowers to the same
            // positional tuple literal as a C# named tuple (issue #1934).
            var single = new { A = 1 };
            Console.WriteLine($"AnonymousObjectCreationExpression: single={single.A}");

            var pair = new { A = 2, B = "two" };
            Console.WriteLine($"AnonymousObjectCreationExpression: pair={pair.A},{pair.B}");
        }
    }
}
