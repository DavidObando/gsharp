// inventory: TypePattern
using System;

namespace Corpus.Grid04.Constructs
{
    public static class TypePatternFixture
    {
        public static void Run()
        {
            object number = 42;
            string classifyNumber = number switch
            {
                int => "int",
                string => "string",
                _ => "other",
            };
            Console.WriteLine($"TypePattern: switch({classifyNumber}) = int expected");

            object text = "hi";
            if (text is string)
            {
                Console.WriteLine("TypePattern: is-test string match");
            }

            switch (number)
            {
                case int:
                    Console.WriteLine("TypePattern: switch-statement int match");
                    break;
                default:
                    Console.WriteLine("TypePattern: switch-statement default");
                    break;
            }

            object whole = 7L;
            string classifyWhole = whole switch
            {
                int or long => "whole number",
                _ => "other",
            };
            Console.WriteLine($"TypePattern: or-combinator switch({classifyWhole}) = whole number expected");
        }
    }
}
