// inventory: DeclarationExpression
using System;
using System.Collections.Generic;

namespace Corpus.Grid09
{
    public static class DeclarationExpressionFixture
    {
        public static void Run()
        {
            // out var + SingleVariableDesignation.
            if (int.TryParse("42", out var n))
            {
                Console.WriteLine($"DeclarationExpression: outVar={n}");
            }

            // Explicitly typed out declaration.
            bool okTyped = int.TryParse("7", out int m);
            Console.WriteLine($"DeclarationExpression: outTyped={m} ok={okTyped}");

            // DiscardDesignation: out _.
            bool okDiscard = int.TryParse("nope", out _);
            Console.WriteLine($"DeclarationExpression: discardParse={okDiscard}");

            var ages = new Dictionary<string, int>
            {
                { "ada", 36 },
            };
            if (ages.TryGetValue("ada", out int age))
            {
                Console.WriteLine($"DeclarationExpression: tryGet={age}");
            }

            bool found = ages.TryGetValue("bob", out var missing);
            Console.WriteLine($"DeclarationExpression: missing={missing} found={found}");
        }
    }
}
