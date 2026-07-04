// inventory: AddExpression
using System;

namespace Corpus.Grid14
{
    public static class StringConcatenationFixture
    {
        public static void Run()
        {
            string first = "con";
            string s = first + "cat" + "enation";
            int n = 42;
            char c = 'x';
            bool b = true;
            string mixed = "n=" + n + " c=" + c + " b=" + b;
            // Issue #1883: concatenating a non-string LITERAL operand lowers
            // to an explicit `.ToString()` call; the literal receiver
            // (`42.ToString()`) must be parenthesized (`(42).ToString()`) or
            // G#'s lexer/parser rejects it (ADR-0054, GS0005/GS0157).
            string literalConcat = "n=" + 42;
            string literalToString = 42.ToString();
            string built = "";
            for (int i = 1; i <= 3; i++)
            {
                built += i.ToString() + ";";
            }

            Console.WriteLine($"StringConcatenation: s={s}");
            Console.WriteLine($"StringConcatenation: mixed={mixed}");
            Console.WriteLine($"StringConcatenation: literalConcat={literalConcat}");
            Console.WriteLine($"StringConcatenation: literalToString={literalToString}");
            Console.WriteLine($"StringConcatenation: built={built}");
        }
    }
}
