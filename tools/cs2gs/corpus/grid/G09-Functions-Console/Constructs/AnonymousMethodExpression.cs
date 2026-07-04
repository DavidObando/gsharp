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

            // Parameterless anonymous method targeting Action<string>: the
            // synthesized param must NOT reuse Invoke's declared param name
            // ("obj"), else it silently shadows the captured outer "obj"
            // local below and the call argument leaks into the body instead.
            string obj = "captured";
            Action<string> shoutObj = delegate
            {
                Console.WriteLine($"AnonymousMethodExpression: shoutObj={obj}");
            };
            shoutObj("ignored");
        }
    }
}
