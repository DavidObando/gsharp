// Issue #1896: range-index forms (a[1..3], a[..2], a[^2..], a[..],
// "gsharp"[1..4]) now lower to gsc's own native range-index syntax instead of
// the unresolvable <receiver>.Slice(...) desugaring.
using System;

namespace Corpus.Grid05
{
    public static class RangeExpressionFixture
    {
        public static void Run()
        {
            int[] a = { 1, 2, 3, 4, 5, 6 };

            int[] mid = a[1..3];
            Console.WriteLine($"RangeExpression: mid={string.Join(",", mid)}");

            int[] head = a[..2];
            Console.WriteLine($"RangeExpression: head={string.Join(",", head)}");

            int[] tail = a[^2..];
            Console.WriteLine($"RangeExpression: tail={string.Join(",", tail)}");

            int[] endTrim = a[1..^1];
            Console.WriteLine($"RangeExpression: endTrim={string.Join(",", endTrim)}");

            int[] allButLast = a[..^1];
            Console.WriteLine($"RangeExpression: allButLast={string.Join(",", allButLast)}");

            int[] all = a[..];
            Console.WriteLine($"RangeExpression: allLen={all.Length}");

            string sliced = "gsharp"[1..4];
            Console.WriteLine($"RangeExpression: sliced={sliced}");

            // ADR-0187 / issue #4350: reusable System.Range values, including a
            // leading from-end bound, round-trip as readable G# range values.
            Range trimmed = ^4..^1;
            int[] saved = a[trimmed];
            Console.WriteLine($"RangeExpression: saved={string.Join(",", saved)} complement={~5}");
        }
    }
}
