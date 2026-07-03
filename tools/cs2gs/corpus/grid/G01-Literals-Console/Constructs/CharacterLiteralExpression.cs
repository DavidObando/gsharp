// inventory: CharacterLiteralExpression
using System;

namespace Corpus.Grid01
{
    public static class CharacterLiteralExpressionFixture
    {
        public static void Run()
        {
            char letter = 'A';
            char newline = '\n';
            char tab = '\t';
            char backslash = '\\';
            char quote = '\'';
            char unicode = '\u0042';
            char hexEscape = '\x43';
            Console.WriteLine($"CharacterLiteralExpression: letter={letter} unicode={unicode} hexEscape={hexEscape}");
            Console.WriteLine($"CharacterLiteralExpression: newlineCode={(int)newline} tabCode={(int)tab}");
            Console.WriteLine($"CharacterLiteralExpression: backslash={backslash} quote={quote}");
        }
    }
}
