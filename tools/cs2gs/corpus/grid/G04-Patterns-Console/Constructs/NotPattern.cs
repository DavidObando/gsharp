// inventory: NotPattern
using System;

namespace Corpus.Grid04.Constructs
{
    public static class NotPatternFixture
    {
        public static void Run()
        {
            object? value = "abc";
            bool notNull = value is not null;
            Console.WriteLine($"NotPattern: \"abc\" is not null = {notNull}");

            bool notInt = value is not int;
            Console.WriteLine($"NotPattern: \"abc\" is not int = {notInt}");

            object? nothing = null;
            bool nothingNotNull = nothing is not null;
            Console.WriteLine($"NotPattern: null is not null = {nothingNotNull}");

            int seven = 7;
            bool notThirteen = seven is not 13;
            Console.WriteLine($"NotPattern: 7 is not 13 = {notThirteen}");
        }
    }
}
