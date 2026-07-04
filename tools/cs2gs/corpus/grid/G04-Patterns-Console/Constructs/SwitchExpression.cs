// inventory: SwitchExpression
using System;

namespace Corpus.Grid04.Constructs
{
    public static class SwitchExpressionFixture
    {
        public static void Run()
        {
            for (int n = -2; n <= 4; n += 2)
            {
                string label = n switch
                {
                    < 0 => "negative",
                    0 => "zero",
                    int v when v % 4 == 0 => $"multiple of four ({v})",
                    var v => $"plain positive ({v})",
                };
                Console.WriteLine($"SwitchExpression: {n} -> {label}");
            }

            string season = 3 switch
            {
                1 => "winter",
                2 => "spring",
                3 => "summer",
                _ => "autumn",
            };
            Console.WriteLine($"SwitchExpression: quarter 3 -> {season}");
        }
    }
}
