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

package Corpus.L3

import System
import System.Collections.Generic
import System.Linq
import System.Threading.Tasks

abstract data class Shape : IEquatable[Shape] { }

data class Circle(Radius float64) : Shape, IEquatable[Circle] { }

data class Rectangle(Width float64, Height float64) : Shape, IEquatable[Rectangle] { }

data class Square(Side float64) : Shape, IEquatable[Square] { }

shared class Shapes {
    // switch expression with type patterns + a property pattern + discard.
    func Area(shape Shape) float64 -> switch shape {
        case Circle{Radius: var r}: Math.PI * r * r
        case Rectangle{Width: var w, Height: var h}: w * h
        case s is Square: s.Side * s.Side
        default: 0.0
    }

    // Property/relational pattern producing a category label.
    func Describe(shape Shape) string -> switch Area(shape) {
        case 0.0: "empty"
        case < 10.0: "small"
        case < 100.0: "medium"
        default: "large"
    }
}

shared class Statistics {
    // LINQ method syntax + a Func<> lambda.
    func SumOfSquaresOfEvens(numbers IEnumerable[int32]) int32 -> numbers
        .Where((n int32) -> n % 2 == 0)
        .Select((n int32) -> n * n)
        .Sum()

    // LINQ query syntax.
    func SortedDistinct(numbers IEnumerable[int32]) IReadOnlyList[int32] {
        let result = numbers.OrderBy((n int32) -> n)
        return result.Distinct().ToList()
    }

    // Higher-order: takes a delegate, returns a delegate (Func<int,int>).
    func Compose(f(int32) -> int32, g(int32) -> int32)(int32) -> int32 -> (x int32) -> f(g(x))

    // Action<> delegate parameter.
    func ForEachIndexed[T](items IEnumerable[T], action(int32, T) -> void) {
        var index = 0
        for item in items {
            action(index, item)
            index++
        }
    }
}

// Extension methods (`this T`) -> G# receiver-clause form.
shared class StringExtensions { }

@ExtensionOwner(typeof(StringExtensions))
func (value string) Repeat(times int32) string {
    if times < 0 {
        throw ArgumentOutOfRangeException("times")
    }
    return string.Concat(Enumerable.Repeat(value, times))
}

@ExtensionOwner(typeof(StringExtensions))
func (value string) WordCount() int32 -> value.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length

shared class AsyncWork {
    // async/await over Task<T>.
    async func SumAsync(numbers IEnumerable[int32]) int32 {
        var total = 0
        for n in numbers {
            total += await IdentityAsync(n)
        }
        return total
    }

    async func ProductAsync(numbers IEnumerable[int32]) int32 {
        var product = 1
        for n in numbers {
            product *= await IdentityAsync(n)
        }
        return product
    }

    private func IdentityAsync(value int32) Task[int32] -> Task.FromResult(value)
}
