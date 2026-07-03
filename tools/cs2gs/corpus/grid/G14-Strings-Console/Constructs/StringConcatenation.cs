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
            string built = "";
            for (int i = 1; i <= 3; i++)
            {
                built += i.ToString() + ";";
            }

            Console.WriteLine($"StringConcatenation: s={s}");
            Console.WriteLine($"StringConcatenation: mixed={mixed}");
            Console.WriteLine($"StringConcatenation: built={built}");
        }
    }
}
