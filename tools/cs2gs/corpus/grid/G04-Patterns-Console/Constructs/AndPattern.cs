// inventory: AndPattern
using System;

namespace Corpus.Grid04.Constructs
{
    public static class AndPatternFixture
    {
        public static void Run()
        {
            for (int n = -5; n <= 15; n += 5)
            {
                bool inRange = n is > 0 and < 10;
                Console.WriteLine($"AndPattern: {n} is > 0 and < 10 = {inRange}");
            }

            object boxed = 7;
            bool intAndBig = boxed is int and > 3;
            Console.WriteLine($"AndPattern: boxed 7 is int and > 3 = {intAndBig}");

            int mid = 50;
            bool chained = mid is >= 0 and <= 100 and not 13;
            Console.WriteLine($"AndPattern: 50 is >= 0 and <= 100 and not 13 = {chained}");
        }
    }
}
