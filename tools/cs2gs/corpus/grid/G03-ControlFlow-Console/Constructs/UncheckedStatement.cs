// inventory: UncheckedStatement
using System;

namespace Corpus.Grid03.Constructs
{
    public static class UncheckedStatementFixture
    {
        public static void Run()
        {
            unchecked
            {
                int big = 2147483647;
                int one = 1;
                int wrapped = big + one;
                Console.WriteLine($"UncheckedStatement: max int plus one wraps to {wrapped}");
            }

            unchecked
            {
                int a = 2000000000;
                int b = 2000000000;
                int sum = a + b;
                Console.WriteLine($"UncheckedStatement: 2000000000 + 2000000000 wraps to {sum}");
            }
        }
    }
}
