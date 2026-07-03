// inventory: EmptyStatement
using System;

namespace Corpus.Grid03.Constructs
{
    public static class EmptyStatementFixture
    {
        public static void Run()
        {
            int counter = 0;
            ;
            counter++;
            ;

            Console.WriteLine($"EmptyStatement: counter after stray semicolons = {counter}");

            int spins;
            for (spins = 0; spins < 3; spins++)
                ;

            Console.WriteLine($"EmptyStatement: loop with empty body spun to {spins}");
        }
    }
}
