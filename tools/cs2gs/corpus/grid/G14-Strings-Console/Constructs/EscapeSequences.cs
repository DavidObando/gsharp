// inventory: StringLiteralExpression
using System;

namespace Corpus.Grid14
{
    public static class EscapeSequencesFixture
    {
        public static void Run()
        {
            string quote = "she said \"hi\"";
            string path = "C:\\temp";
            string uni = "\u0041\u0042C";
            string newlineOnly = "\n";
            string nulOnly = "\0";
            Console.WriteLine($"EscapeSequences: quote={quote}");
            Console.WriteLine($"EscapeSequences: path={path}");
            Console.WriteLine($"EscapeSequences: uni={uni}");
            Console.WriteLine($"EscapeSequences: newlineCode={(int)newlineOnly[0]} nulCode={(int)nulOnly[0]}");
        }
    }
}
