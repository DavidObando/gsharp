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

            // Issue #1882: literal brace escapes (`{{`/`}}`) alongside a real
            // hole and a literal `$`, in a non-verbatim interpolated string.
            Console.WriteLine($"braces={{x}} dollar=$9.99");
            Console.WriteLine($"braces={{{x}}} hole={x}");

            // Literal braces in a plain (non-interpolated) string need no
            // escaping at all in C# or G#.
            Console.WriteLine("plain braces: {x} and {{y}}");
        }
    }
}
