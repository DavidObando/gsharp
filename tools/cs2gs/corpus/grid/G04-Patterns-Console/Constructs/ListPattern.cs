// inventory: ListPattern, SlicePattern
using System;

namespace Corpus.Grid04.Constructs
{
    public static class ListPatternFixture
    {
        public static void Run()
        {
            int[] exact = { 1, 2, 3, 4 };
            if (exact is [1, 2, 3, 4])
            {
                Console.WriteLine("ListPattern: exact length match");
            }

            int[] edges = { 1, 9, 9, 4 };
            if (edges is [1, .., 4])
            {
                Console.WriteLine("ListPattern: edge slice match");
            }

            int[] empty = { };
            if (empty is [])
            {
                Console.WriteLine("ListPattern: empty match");
            }

            int[] headRest = { 10, 20, 30 };
            if (headRest is [var head, .. var rest])
            {
                Console.WriteLine($"ListPattern: head={head} restLength={rest.Length}");
            }

            int[] switchEdges = { 1, 2, 3, 4 };
            string classifyEdges = switchEdges switch
            {
                [] => "empty",
                [1, .., 4] => "edges",
                [var only] => $"single:{only}",
                _ => "other",
            };
            Console.WriteLine($"ListPattern: switch({classifyEdges}) = edges expected");

            int[] switchEmpty = { };
            string classifyEmpty = switchEmpty switch
            {
                [] => "empty",
                [1, .., 4] => "edges",
                [var only] => $"single:{only}",
                _ => "other",
            };
            Console.WriteLine($"ListPattern: switch({classifyEmpty}) = empty expected");

            int[] switchSingle = { 7 };
            string classifySingle = switchSingle switch
            {
                [] => "empty",
                [1, .., 4] => "edges",
                [var only] => $"single:{only}",
                _ => "other",
            };
            Console.WriteLine($"ListPattern: switch({classifySingle}) = single expected");
        }
    }
}
