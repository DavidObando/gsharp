// inventory: CollectionExpression
using System;

namespace Corpus.Grid05
{
    public static class CollectionExpressionFixture
    {
        public static void Run()
        {
            int[] a = [1, 2, 3];
            Console.WriteLine($"CollectionExpression: array={string.Join(",", a)}");

            // QUARANTINED (GS0155): List<T>-targeted collection expressions
            // (List<int> l = [10, 20];) lower to a G# array literal []int32{...}
            // that does not convert to List[int32].
            // QUARANTINED (CS2GS-GAP): SpreadElement — collection-expression
            // spread ([0, .. rest, 9]) has no canonical G# composite-literal
            // form yet.
            string[] ss = ["x", "y", "z"];
            Console.WriteLine($"CollectionExpression: strings={string.Join(",", ss)}");

            int[] empty = [];
            Console.WriteLine($"CollectionExpression: emptyLen={empty.Length}");
        }
    }
}
