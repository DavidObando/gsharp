// inventory: IndexExpression
using System;

namespace Corpus.Grid05
{
    public static class IndexExpressionFixture
    {
        public static void Run()
        {
            int[] a = { 1, 2, 3, 4, 5 };
            Console.WriteLine($"IndexExpression: last={a[^1]} secondLast={a[^2]}");

            // ADR-0192 / issue #4350: a saved System.Index is a first-class
            // G# value, so `Index third = ^3; a[third]` keeps from-end meaning.
            Index third = ^3;
            Console.WriteLine($"IndexExpression: third={a[third]} fromEnd={third.IsFromEnd} offset={third.GetOffset(a.Length)}");

            string word = "gsharp";
            Console.WriteLine($"IndexExpression: lastChar={word[^1]}");
        }
    }
}
