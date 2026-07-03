// inventory: ReturnStatement
using System;

namespace Corpus.Grid03.Constructs
{
    public static class ReturnStatementFixture
    {
        public static void Run()
        {
            Console.WriteLine($"ReturnStatement: Classify(-4) = {Classify(-4)}");
            Console.WriteLine($"ReturnStatement: Classify(0) = {Classify(0)}");
            Console.WriteLine($"ReturnStatement: Classify(9) = {Classify(9)}");

            PrintIfEven(3);
            PrintIfEven(8);
        }

        private static string Classify(int n)
        {
            if (n < 0)
            {
                return "negative";
            }

            if (n == 0)
            {
                return "zero";
            }

            return "positive";
        }

        private static void PrintIfEven(int n)
        {
            if (n % 2 != 0)
            {
                return;
            }

            Console.WriteLine($"ReturnStatement: {n} is even (void early return skipped odd)");
        }
    }
}
