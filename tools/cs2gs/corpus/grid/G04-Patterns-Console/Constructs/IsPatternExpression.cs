// inventory: IsPatternExpression
using System;
using System.Collections.Generic;

namespace Corpus.Grid04.Constructs
{
    // ADR-0166 / issue #3409: `is` patterns whose designations become native G#
    // pattern variables — nested property designations with an `&&`
    // continuation, negated guards whose binder is used after the `if`,
    // property/empty-brace designations, ternary and loop conditions.
    public static class IsPatternExpressionFixture
    {
        private sealed class Symbol
        {
            public bool IsClass { get; init; }
        }

        private sealed class Receiver
        {
            public object? Type { get; init; }
        }

        private sealed class Access
        {
            public Receiver? Receiver { get; init; }
        }

        private static bool HasClassReceiver(Access access)
        {
            if (access.Receiver is { Type: Symbol s } && s.IsClass)
            {
                return true;
            }

            return false;
        }

        private static string Describe(object? value)
        {
            if (value is not string text)
            {
                return "not text";
            }

            return $"text of length {text.Length}";
        }

        private static string Bound(int? maybe, string? name)
        {
            string result = maybe is { } n ? $"n={n}" : "n=nil";
            if (name is { Length: > 3 } longName)
            {
                result += $" long name {longName}";
            }

            return result;
        }

        private static int Drain(Queue<object> queue)
        {
            int total = 0;
            while (queue.Count > 0 && queue.Dequeue() is int value)
            {
                total += value;
            }

            return total;
        }

        public static void Run()
        {
            Console.WriteLine($"IsPatternExpression: class receiver = {HasClassReceiver(new Access { Receiver = new Receiver { Type = new Symbol { IsClass = true } } })}");
            Console.WriteLine($"IsPatternExpression: struct receiver = {HasClassReceiver(new Access { Receiver = new Receiver { Type = new Symbol { IsClass = false } } })}");
            Console.WriteLine($"IsPatternExpression: nil receiver = {HasClassReceiver(new Access())}");
            Console.WriteLine($"IsPatternExpression: {Describe("hello")}");
            Console.WriteLine($"IsPatternExpression: {Describe(42)}");
            Console.WriteLine($"IsPatternExpression: {Bound(7, "gsharp")}");
            Console.WriteLine($"IsPatternExpression: {Bound(null, "gs")}");

            var queue = new Queue<object>();
            queue.Enqueue(1);
            queue.Enqueue(2);
            queue.Enqueue("stop");
            queue.Enqueue(9);
            Console.WriteLine($"IsPatternExpression: drained {Drain(queue)} with {queue.Count} left");
        }
    }
}
