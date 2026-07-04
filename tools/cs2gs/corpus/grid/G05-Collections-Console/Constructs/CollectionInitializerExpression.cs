// inventory: CollectionInitializerExpression
using System;
using System.Collections.Generic;

namespace Corpus.Grid05
{
    public static class CollectionInitializerExpressionFixture
    {
        public static void Run()
        {
            var list = new List<int> { 1, 2, 3 };
            Console.WriteLine($"CollectionInitializerExpression: list={string.Join(",", list)}");

            // ComplexElementInitializerExpression: { key, value } pairs.
            var pairs = new Dictionary<string, int>
            {
                { "apple", 3 },
                { "kiwi", 1 },
                { "pear", 2 },
            };
            PrintOrdered("pairs", pairs);

            // ImplicitElementAccess: the ["key"] = value dictionary-initializer
            // form (issue #1897 — was CS2GS-GAP; already had a canonical G#
            // form via the existing indexed CollectionInitializerElement path,
            // this fixture just re-enables the corpus coverage for it).
            var indexed = new Dictionary<string, int>
            {
                ["blue"] = 2,
                ["red"] = 5,
                ["green"] = 4,
            };
            PrintOrdered("indexed", indexed);
        }

        private static void PrintOrdered(string label, Dictionary<string, int> map)
        {
            var keys = new List<string>(map.Keys);
            keys.Sort(StringComparer.Ordinal);
            var parts = new List<string>();
            foreach (string key in keys)
            {
                parts.Add($"{key}={map[key]}");
            }

            Console.WriteLine($"CollectionInitializerExpression: {label} {string.Join(";", parts)}");
        }
    }
}
