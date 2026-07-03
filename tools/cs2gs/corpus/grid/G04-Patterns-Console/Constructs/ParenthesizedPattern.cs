// inventory: ParenthesizedPattern
using System;

namespace Corpus.Grid04.Constructs
{
    public static class ParenthesizedPatternFixture
    {
        public static void Run()
        {
            int[] values = { -3, 5, 42, 77 };
            foreach (int v in values)
            {
                bool special = v is (> 0 and < 10) or 42;
                Console.WriteLine($"ParenthesizedPattern: {v} is (> 0 and < 10) or 42 = {special}");
            }

            int nine = 9;
            bool grouped = nine is not (< 0 or > 10);
            Console.WriteLine($"ParenthesizedPattern: 9 is not (< 0 or > 10) = {grouped}");
        }
    }
}
