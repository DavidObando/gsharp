// inventory: DeclarationPattern
using System;

namespace Corpus.Grid04.Constructs
{
    public static class DeclarationPatternFixture
    {
        public static void Run()
        {
            object payload = "gsharp";
            if (payload is string text)
            {
                Console.WriteLine($"DeclarationPattern: string binder saw length {text.Length}");
            }

            object number = 12;
            if (number is int n && n > 10)
            {
                Console.WriteLine($"DeclarationPattern: int binder saw {n} (> 10)");
            }

            if (payload is int wrong)
            {
                Console.WriteLine($"DeclarationPattern: unexpected int {wrong}");
            }
            else
            {
                Console.WriteLine("DeclarationPattern: string payload is not an int");
            }
        }
    }
}
