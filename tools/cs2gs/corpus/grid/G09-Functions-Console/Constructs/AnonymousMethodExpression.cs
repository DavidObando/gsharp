// inventory: AnonymousMethodExpression
using System;

namespace Corpus.Grid09
{
    public static class AnonymousMethodExpressionFixture
    {
        public static void Run()
        {
            Func<int, int> inc = delegate (int x)
            {
                return x + 1;
            };
            Console.WriteLine($"AnonymousMethodExpression: inc(41)={inc(41)}");

            // Parameterless anonymous method (no parameter list at all).
            Func<int> answer = delegate
            {
                return 42;
            };
            Console.WriteLine($"AnonymousMethodExpression: answer={answer()}");

            // Parameterless anonymous method targeting a zero-arg delegate type.
            Action greet = delegate
            {
                Console.WriteLine("AnonymousMethodExpression: greet=hi");
            };
            greet();

            Action<string> shout = delegate (string s)
            {
                Console.WriteLine($"AnonymousMethodExpression: shout {s}!");
            };
            shout("hey");
        }
    }
}
