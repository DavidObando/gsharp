// inventory: CollectionExpression
using System;
using System.Collections.Generic;

namespace Corpus.Grid05
{
    public static class CollectionExpressionFixture
    {
        public static void Run()
        {
            int[] a = [1, 2, 3];
            Console.WriteLine($"CollectionExpression: array={string.Join(",", a)}");

            string[] ss = ["x", "y", "z"];
            Console.WriteLine($"CollectionExpression: strings={string.Join(",", ss)}");

            int[] empty = [];
            Console.WriteLine($"CollectionExpression: emptyLen={empty.Length}");

            // List<T>-targeted collection expression (issue #1897): lowers to
            // the G# collection-initializer form (List[int32]{...}), not an
            // array literal (which does not convert to List[int32]).
            List<int> list = [10, 20];
            Console.WriteLine($"CollectionExpression: list={string.Join(",", list)} count={list.Count}");

            // SpreadElement (issue #1897): lowers to a build-and-append
            // temporary List populated via Add/AddRange, converted back with
            // ToArray() for the array target.
            int[] rest = [2, 3];
            int[] spread = [1, .. rest, 9];
            Console.WriteLine($"CollectionExpression: spread={string.Join(",", spread)}");
        }
    }
}

