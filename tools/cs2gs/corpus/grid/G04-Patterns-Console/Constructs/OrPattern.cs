// inventory: OrPattern
using System;

namespace Corpus.Grid04.Constructs
{
    public static class OrPatternFixture
    {
        public static void Run()
        {
            int[] codes = { 200, 201, 204, 404, 500 };
            foreach (int code in codes)
            {
                bool success = code is 200 or 201 or 204;
                Console.WriteLine($"OrPattern: status {code} is success = {success}");
            }

            char[] letters = { 'a', 'b', 'e', 'z' };
            foreach (char c in letters)
            {
                bool vowel = c is 'a' or 'e' or 'i' or 'o' or 'u';
                Console.WriteLine($"OrPattern: '{c}' is vowel = {vowel}");
            }

            int outlier = 150;
            bool outOfRange = outlier is < 0 or > 100;
            Console.WriteLine($"OrPattern: 150 is < 0 or > 100 = {outOfRange}");
        }
    }
}
