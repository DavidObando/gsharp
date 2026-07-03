// inventory: IdentifierName
using System;
using System.Linq;

namespace Corpus.Grid09
{
    public static class MethodGroupConversionFixture
    {
        public static void Run()
        {
            // Method group to Func<>.
            Func<int, int> f = Twice;
            Console.WriteLine($"MethodGroupConversion: func={f(21)}");

            // Method group to Action<>.
            Action<string> a = Emit;
            a("action");

            // Method group passed straight to LINQ.
            var doubled = new[] { 1, 2, 3 }.Select(Twice);
            Console.WriteLine($"MethodGroupConversion: linq={string.Join(",", doubled)}");

            // Instance method group.
            var counter = new Tally();
            Func<int, int> g = counter.Bump;
            Console.WriteLine($"MethodGroupConversion: instance={g(5)},{g(5)}");
        }

        private static int Twice(int x)
        {
            return x * 2;
        }

        private static void Emit(string s)
        {
            Console.WriteLine($"MethodGroupConversion: emit {s}");
        }

        private sealed class Tally
        {
            private int _total;

            public int Bump(int by)
            {
                _total += by;
                return _total;
            }
        }
    }
}
