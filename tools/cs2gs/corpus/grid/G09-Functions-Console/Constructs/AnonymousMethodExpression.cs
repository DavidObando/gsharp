// inventory: AnonymousMethodExpression
using System;

namespace Corpus.Grid09
{
    internal delegate void CollisionHandler(string obj, int generated, bool init);
    internal delegate int RefAnonymousMethodHandler(ref int value);
    internal delegate int InAnonymousMethodHandler(in int value);
    internal delegate int VariadicAnonymousMethodHandler(params int[] values);

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

            // Driver coverage: the inferred slots become repeatable G# `_`
            // parameters that bind, compile, and run. Focused unit tests
            // discriminate collision and shadowing behavior.
            int generated = 42;
            bool init = true;
            CollisionHandler collisions = delegate
            {
                Console.WriteLine($"AnonymousMethodExpression: collisions={obj}/{generated}/{init}");
            };
            collisions("ignored", 0, false);

            // C# permits omitted anonymous-method parameter lists for ref, in,
            // and params-array delegate slots. The body cannot name any slot.
            RefAnonymousMethodHandler byRef = delegate { return generated; };
            InAnonymousMethodHandler readOnly = delegate { return generated + 1; };
            VariadicAnonymousMethodHandler variadic = delegate { return generated + 2; };
            int value = 5;
            Console.WriteLine(
                $"AnonymousMethodExpression: modifiers={byRef(ref value)}/{readOnly(in value)}/{variadic(1, 2, 3)}/{value}");
        }
    }
}
