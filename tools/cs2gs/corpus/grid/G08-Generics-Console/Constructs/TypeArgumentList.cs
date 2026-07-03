// inventory: TypeArgumentList — nested constructed generics (Dictionary<string, List<int>>)
using System;
using System.Collections.Generic;

namespace Corpus.Grid08
{
    public static class TypeArgumentListFixture
    {
        public static void Run()
        {
            Dictionary<string, List<int>> buckets = new Dictionary<string, List<int>>();
            List<int> evens = new List<int>();
            evens.Add(2);
            evens.Add(4);
            buckets["evens"] = evens;

            List<int> odds = new List<int>();
            odds.Add(1);
            buckets["odds"] = odds;

            Console.WriteLine("TypeArgumentList: evens=" + buckets["evens"].Count.ToString());
            Console.WriteLine("TypeArgumentList: first-even=" + buckets["evens"][0].ToString());
            Console.WriteLine("TypeArgumentList: odds=" + buckets["odds"].Count.ToString());
            Console.WriteLine("TypeArgumentList: keys=" + buckets.Count.ToString());
        }
    }
}
