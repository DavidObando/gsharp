// inventory: InterpolationAlignmentClause
using System;

namespace Corpus.Grid14
{
    public static class InterpolationAlignmentClauseFixture
    {
        public static void Run()
        {
            int n = 42;
            string s = "hi";
            Console.WriteLine($"InterpolationAlignmentClause: [{n,6}] [{s,-6}] [{n,2}]");
            Console.WriteLine($"InterpolationAlignmentClause: [{s,8}] [{n,-8}]");
        }
    }
}
