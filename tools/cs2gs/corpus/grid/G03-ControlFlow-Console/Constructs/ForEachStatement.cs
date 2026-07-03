// inventory: ForEachStatement
using System;
using System.Collections.Generic;

namespace Corpus.Grid03.Constructs
{
    public static class ForEachStatementFixture
    {
        public static void Run()
        {
            int[] primes = { 2, 3, 5, 7, 11 };
            int sum = 0;
            foreach (int p in primes)
            {
                sum += p;
            }

            Console.WriteLine($"ForEachStatement: sum of first five primes = {sum}");

            var names = new List<string>();
            names.Add("ada");
            names.Add("bea");
            names.Add("cid");
            foreach (string name in names)
            {
                Console.WriteLine($"ForEachStatement: name {name}");
            }

            var stock = new Dictionary<string, int>();
            stock["pen"] = 4;
            stock["ink"] = 9;
            stock["pad"] = 2;

            var keys = new List<string>();
            foreach (string key in stock.Keys)
            {
                keys.Add(key);
            }

            keys.Sort();
            foreach (string key in keys)
            {
                Console.WriteLine($"ForEachStatement: stock[{key}] = {stock[key]}");
            }
        }
    }
}
