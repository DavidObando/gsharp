// inventory: YieldReturnStatement
using System;
using System.Collections.Generic;

namespace Corpus.Grid03.Constructs
{
    public static class YieldReturnStatementFixture
    {
        public static void Run()
        {
            int sum = 0;
            foreach (int f in Fibonacci(8))
            {
                sum += f;
                Console.WriteLine($"YieldReturnStatement: fib {f}");
            }

            Console.WriteLine($"YieldReturnStatement: sum of first 8 fibs = {sum}");
        }

        private static IEnumerable<int> Fibonacci(int count)
        {
            int a = 0;
            int b = 1;
            for (int i = 0; i < count; i++)
            {
                yield return a;
                int next = a + b;
                a = b;
                b = next;
            }
        }
    }
}
