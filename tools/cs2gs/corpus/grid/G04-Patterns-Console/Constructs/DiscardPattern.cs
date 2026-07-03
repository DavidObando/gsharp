// inventory: DiscardPattern
// NOTE: quarantined sub-case: a bare-type switch-expression arm (`int => ...`)
// fails stage 1 with CS2GS-GAP "pattern 'TypePattern' has no canonical G# form
// yet (ADR-0115 §B)". Only discard arms alongside constant/relational arms are
// kept below.
using System;

namespace Corpus.Grid04.Constructs
{
    public static class DiscardPatternFixture
    {
        public static void Run()
        {
            for (int i = 0; i <= 2; i++)
            {
                string label = i switch
                {
                    0 => "zero",
                    _ => "nonzero",
                };
                Console.WriteLine($"DiscardPattern: {i} -> {label}");
            }

            int temp = -5;
            string sign = temp switch
            {
                < 0 => "negative",
                _ => "non-negative",
            };
            Console.WriteLine($"DiscardPattern: {temp} -> {sign}");
        }
    }
}
