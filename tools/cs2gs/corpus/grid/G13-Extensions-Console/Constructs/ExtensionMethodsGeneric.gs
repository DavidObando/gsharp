// inventory: MethodDeclaration — generic extension methods, including inside LINQ chains
// A generic extension over IReadOnlyList<T> and a generic transform used in
// the middle of a Where/Select LINQ chain.

package Corpus.Grid13.Constructs

import System
import System.Collections.Generic
import System.Linq

shared class GenericExtensions { }

// Issue #1926 (fixed): `this IReadOnlyList<T> items` — a receiver-clause
// (extension) function whose declared receiver is a constructed generic
// CLR interface must accept a concrete implementing type at the call
// site (`List<int>`/`List<string>` both implement `IReadOnlyList<T>`).
@ExtensionOwner(typeof(GenericExtensions))
func (items IReadOnlyList[T]) MiddleElement[T]() T {
    return items[items.Count / 2]
}

@ExtensionOwner(typeof(GenericExtensions))
func (source IEnumerable[T]) MapPairs[T, TResult](combine(T, T) -> TResult) sequence[TResult] {
    let buffered = source.ToList()
    for var i = 0; i + 1 < buffered.Count; i += 2 {
        yield combine(buffered[i], buffered[i + 1])
    }
}

shared class ExtensionMethodsGenericFixture {
    func Run() {
        let numbers = List[int32]{1, 2, 3, 4, 5, 6, 7}
        Console.WriteLine("ExtensionMethodsGeneric: middleInt=${numbers.MiddleElement()}")
        let words = List[string]{"alpha", "beta", "gamma"}
        Console.WriteLine("ExtensionMethodsGeneric: middleWord=${words.MiddleElement()}")
        let chained = numbers
            .Where((n int32) -> n % 2 == 1)
            .MapPairs((a int32, b int32) -> a + b)
            .Select((n int32) -> n * 10)
            .ToList()
        Console.WriteLine("ExtensionMethodsGeneric: chained=${string.Join(",", chained)}")
    }
}
