// inventory: InterpolatedStringExpression
using System;

namespace Corpus.Grid14
{
    public static class InterpolatedStringExpressionFixture
    {
        public static void Run()
        {
            string name = "Ada";
            int year = 1843;
            Console.WriteLine($"InterpolatedStringExpression: basic={name} wrote notes in {year}");
            Console.WriteLine($@"InterpolatedStringExpression: verbatim=C:\data\{name}");
            Console.WriteLine($"""InterpolatedStringExpression: raw="{name}" quoted""");
        }
    }
}
