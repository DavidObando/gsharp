// inventory: IsPatternExpression

package Corpus.Grid04.Constructs

import System
import System.Collections.Generic

// ADR-0166 / issue #3409: `is` patterns whose designations become native G#
// pattern variables — nested property designations with an `&&`
// continuation, negated guards whose binder is used after the `if`,
// property/empty-brace designations, ternary and loop conditions.
shared class IsPatternExpressionFixture {
    private class Symbol {
        prop IsClass bool {
            get;
            init;
        }
    }

    private class Receiver {
        prop Type object? {
            get;
            init;
        }
    }

    private class Access {
        prop Receiver Receiver? {
            get;
            init;
        }
    }

    private func HasClassReceiver(access Access) bool {
        if access.Receiver is {Type: Symbol s} && s.IsClass {
            return true
        }
        return false
    }

    private func Describe(value object?) string {
        if value is not string text {
            return "not text"
        }
        return "text of length ${text.Length}"
    }

    private func Bound(maybe int32?, name string?) string {
        var result = if maybe is {} n {
            "n=$n"
        } else {
            "n=nil"
        }
        if name is {Length: > 3} longName {
            result += " long name $longName"
        }
        return result
    }

    private func Drain(queue Queue[object]) int32 {
        var total = 0
        while queue.Count > 0 && queue.Dequeue() is int32 value {
            total += value
        }
        return total
    }

    func Run() {
        Console.WriteLine(
            "IsPatternExpression: class receiver = ${HasClassReceiver(Access{Receiver: Receiver{Type: Symbol{IsClass: true}}})}"
        )
        Console.WriteLine(
            "IsPatternExpression: struct receiver = ${HasClassReceiver(Access{Receiver: Receiver{Type: Symbol{IsClass: false}}})}"
        )
        Console.WriteLine("IsPatternExpression: nil receiver = ${HasClassReceiver(Access())}")
        Console.WriteLine("IsPatternExpression: ${Describe("hello")}")
        Console.WriteLine("IsPatternExpression: ${Describe(42)}")
        Console.WriteLine("IsPatternExpression: ${Bound(7, "gsharp")}")
        Console.WriteLine("IsPatternExpression: ${Bound(nil, "gs")}")
        let queue = Queue[object]()
        queue.Enqueue(1)
        queue.Enqueue(2)
        queue.Enqueue("stop")
        queue.Enqueue(9)
        Console.WriteLine("IsPatternExpression: drained ${Drain(queue)} with ${queue.Count} left")
    }
}
