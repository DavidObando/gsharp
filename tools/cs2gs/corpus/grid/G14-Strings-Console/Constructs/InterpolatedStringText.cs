// inventory: InterpolatedStringText
using System;

namespace Corpus.Grid14
{
    public static class InterpolatedStringTextFixture
    {
        public static void Run()
        {
            int x = 5;
            Console.WriteLine($"InterpolatedStringText: value={x} dollar=$9.99");
            Console.WriteLine($"InterpolatedStringText: left-{x}-middle-{x + 1}-right");
        }
    }
}
