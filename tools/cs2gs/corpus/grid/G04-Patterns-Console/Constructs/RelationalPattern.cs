// inventory: RelationalPattern
using System;

namespace Corpus.Grid04.Constructs
{
    public static class RelationalPatternFixture
    {
        public static void Run()
        {
            int[] temps = { -10, 0, 15, 22, 30, 41 };
            foreach (int t in temps)
            {
                // The final arm is a discard rather than `>= 30`: gsc requires
                // switch expressions to carry a `default` arm (GS0176).
                string band = t switch
                {
                    < 0 => "freezing",
                    <= 15 => "cold",
                    < 30 => "mild",
                    _ => "hot",
                };
                Console.WriteLine($"RelationalPattern: {t} degrees is {band}");
            }

            int n = 8;
            bool positive = n is > 0;
            bool atMostEight = n is <= 8;
            Console.WriteLine($"RelationalPattern: 8 is > 0 = {positive}, 8 is <= 8 = {atMostEight}");
        }
    }
}
