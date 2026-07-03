// inventory: NameColon
using System;

namespace Corpus.Grid09
{
    public static class NameColonFixture
    {
        public static void Run()
        {
            Console.WriteLine($"NameColon: inOrder={Describe(name: "cat", count: 2, loud: false)}");
            Console.WriteLine($"NameColon: outOfOrder={Describe(count: 1, loud: true, name: "dog")}");
            Console.WriteLine($"NameColon: mixed={Describe("fox", loud: false, count: 3)}");
        }

        private static string Describe(string name, int count, bool loud)
        {
            string text = $"{count}x{name}";
            return loud ? text.ToUpperInvariant() : text;
        }
    }
}
