// inventory: CoalesceAssignmentExpression
using System;

namespace Corpus.Grid02
{
    public static class CoalesceAssignmentExpressionFixture
    {
        public static void Run()
        {
            string? name = null;
            name ??= "fallback";
            string? keep = "kept";
            keep ??= "ignored";
            Console.WriteLine($"CoalesceAssignmentExpression: name={name} keep={keep}");
        }
    }
}
