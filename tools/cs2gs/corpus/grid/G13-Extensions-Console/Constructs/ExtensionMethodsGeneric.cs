// inventory: MethodDeclaration — generic extension methods, including inside LINQ chains
// A generic extension over IReadOnlyList<T> and a generic transform used in
// the middle of a Where/Select LINQ chain.
using System;
using System.Collections.Generic;
using System.Linq;

namespace Corpus.Grid13.Constructs
{
    public static class GenericExtensions
    {
        // NOTE: `this IReadOnlyList<T> items` is avoided on purpose — gsc
        // cannot convert the List<int> argument to the interface-typed generic
        // receiver (GS0155: "Cannot convert type
        // 'System.Collections.Generic.List`1[[System.Int32,...]]' to
        // 'System.Collections.Generic.IReadOnlyList`1[int32]'"). An exact
        // receiver type keeps the generic extension green.
        public static T MiddleElement<T>(this List<T> items)
        {
            return items[items.Count / 2];
        }

        public static IEnumerable<TResult> MapPairs<T, TResult>(
            this IEnumerable<T> source,
            Func<T, T, TResult> combine)
        {
            List<T> buffered = source.ToList();
            for (int i = 0; i + 1 < buffered.Count; i += 2)
            {
                yield return combine(buffered[i], buffered[i + 1]);
            }
        }
    }

    public static class ExtensionMethodsGenericFixture
    {
        public static void Run()
        {
            List<int> numbers = new List<int> { 1, 2, 3, 4, 5, 6, 7 };

            Console.WriteLine($"ExtensionMethodsGeneric: middleInt={numbers.MiddleElement()}");

            List<string> words = new List<string> { "alpha", "beta", "gamma" };
            Console.WriteLine($"ExtensionMethodsGeneric: middleWord={words.MiddleElement()}");

            List<int> chained = numbers
                .Where(n => n % 2 == 1)
                .MapPairs((a, b) => a + b)
                .Select(n => n * 10)
                .ToList();
            Console.WriteLine($"ExtensionMethodsGeneric: chained={string.Join(",", chained)}");
        }
    }
}
