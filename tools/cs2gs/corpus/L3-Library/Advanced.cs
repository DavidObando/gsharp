// L3-Library, part 2: pattern matching, LINQ, delegates/lambdas, an extension
// method, and async/await.
//
// Exercises (ADR-0115 section B):
//   B.5  extension method (`this T`) -> receiver-clause form
//   B.7  generic delegates
//   B.8  delegate types / Func<> / lambdas -> arrow form
//   pattern matching: switch expression, type + property patterns
//   LINQ: method syntax and query syntax
//   async/await over Task<T>
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Corpus.L3
{
    public abstract record Shape;

    public sealed record Circle(double Radius) : Shape;

    public sealed record Rectangle(double Width, double Height) : Shape;

    public sealed record Square(double Side) : Shape;

    public static class Shapes
    {
        // switch expression with type patterns + a property pattern + discard.
        public static double Area(Shape shape) => shape switch
        {
            Circle { Radius: var r } => Math.PI * r * r,
            Rectangle { Width: var w, Height: var h } => w * h,
            Square s => s.Side * s.Side,
            _ => 0.0,
        };

        // Property/relational pattern producing a category label.
        public static string Describe(Shape shape) => Area(shape) switch
        {
            0.0 => "empty",
            < 10.0 => "small",
            < 100.0 => "medium",
            _ => "large",
        };
    }

    public static class Statistics
    {
        // LINQ method syntax + a Func<> lambda.
        public static int SumOfSquaresOfEvens(IEnumerable<int> numbers) =>
            numbers.Where(n => n % 2 == 0)
                   .Select(n => n * n)
                   .Sum();

        // LINQ query syntax.
        public static IReadOnlyList<int> SortedDistinct(IEnumerable<int> numbers)
        {
            var result =
                from n in numbers
                orderby n
                select n;

            return result.Distinct().ToList();
        }

        // Higher-order: takes a delegate, returns a delegate (Func<int,int>).
        public static Func<int, int> Compose(Func<int, int> f, Func<int, int> g) =>
            x => f(g(x));

        // Action<> delegate parameter.
        public static void ForEachIndexed<T>(IEnumerable<T> items, Action<int, T> action)
        {
            int index = 0;
            foreach (var item in items)
            {
                action(index, item);
                index++;
            }
        }
    }

    // Extension methods (`this T`) -> G# receiver-clause form.
    public static class StringExtensions
    {
        public static string Repeat(this string value, int times)
        {
            if (times < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(times));
            }

            return string.Concat(Enumerable.Repeat(value, times));
        }

        public static int WordCount(this string value) =>
            value.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
    }

    public static class AsyncWork
    {
        // async/await over Task<T>.
        public static async Task<int> SumAsync(IEnumerable<int> numbers)
        {
            int total = 0;
            foreach (var n in numbers)
            {
                total += await IdentityAsync(n);
            }

            return total;
        }

        public static async Task<int> ProductAsync(IEnumerable<int> numbers)
        {
            int product = 1;
            foreach (var n in numbers)
            {
                product *= await IdentityAsync(n);
            }

            return product;
        }

        private static Task<int> IdentityAsync(int value) => Task.FromResult(value);
    }
}
