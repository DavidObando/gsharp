// inventory: InterpolationFormatClause
using System;

namespace Corpus.Grid14
{
    public static class InterpolationFormatClauseFixture
    {
        public static void Run()
        {
            int n = 255;
            double d = 3.14159;
            Console.WriteLine($"InterpolationFormatClause: hex={n:X4} dec={n:D6}");
            Console.WriteLine($"InterpolationFormatClause: f2={d:F2} padded={d,10:F3}");
        }
    }
}
