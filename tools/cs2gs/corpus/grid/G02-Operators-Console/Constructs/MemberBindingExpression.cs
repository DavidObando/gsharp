// inventory: MemberBindingExpression
using System;

namespace Corpus.Grid02
{
    public static class MemberBindingExpressionFixture
    {
        public static void Run()
        {
            string? word = "world";
            string? nothing = null;
            string upper = word?.ToUpperInvariant() ?? "null";
            string absent = nothing?.ToUpperInvariant() ?? "null";
            Console.WriteLine($"MemberBindingExpression: upper={upper} absent={absent}");
        }
    }
}
