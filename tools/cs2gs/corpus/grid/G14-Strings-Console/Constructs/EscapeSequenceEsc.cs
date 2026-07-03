// inventory: StringLiteralExpression
using System;

namespace Corpus.Grid14
{
    public static class EscapeSequenceEscFixture
    {
        public static void Run()
        {
            string esc = "\e";
            Console.WriteLine($"EscapeSequenceEsc: len={esc.Length} code={(int)esc[0]}");
        }
    }
}
