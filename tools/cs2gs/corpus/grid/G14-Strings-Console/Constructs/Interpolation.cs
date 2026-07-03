// inventory: Interpolation
using System;

namespace Corpus.Grid14
{
    public static class InterpolationFixture
    {
        public static void Run()
        {
            int a = 6;
            int b = 7;
            string inner = "in";
            string nested = $"outer[{$"inner({inner})"}]";
            string cond = a < b ? "less" : "more";
            Console.WriteLine($"Interpolation: sum={a + b} product={a * b}");
            Console.WriteLine($"Interpolation: call={inner.ToUpperInvariant()} cond={cond}");
            Console.WriteLine($"Interpolation: nested={nested}");
        }
    }
}
