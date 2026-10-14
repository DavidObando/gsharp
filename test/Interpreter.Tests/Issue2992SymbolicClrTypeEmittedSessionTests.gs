// <copyright file="Issue2992SymbolicClrTypeEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Emitted-session coverage for reifying imported generic types over function
/// type parameters.
open class Issue2992SymbolicClrTypeEmittedSessionTests {
    @Fact
    func StaticClrCallUsesClosedContainer() {
        let source = `import GSharp.Interpreter.Tests.ProbeRef

func Marker[T]() int32 {
    return GenericStaticSlot[T].GetMarker()
}

Console.WriteLine(Marker[int32]())`
        Assert.Equal("11${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func StaticPropertyReadUsesClosedContainer() {
        let source = `import System.Collections.Generic

func ComparerName[T]() string {
    return Comparer[T].Default.GetType().Name
}

Console.WriteLine(ComparerName[int32]())`
        Assert.Equal("GenericComparer`1${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func ConstructorUsesClosedClrType() {
        let source = `import System.Collections.Generic

func Make[T]() List[T] {
    return List[T]()
}

var numbers = Make[int32]()
numbers.Add(33)
Console.WriteLine(numbers[0])`
        Assert.Equal("33${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func PropertyReadUsesClosedReceiver() {
        let source = `import System.Collections.Generic

func CapacityOf[T](items List[T]) int32 {
    return items.Capacity
}

var numbers = List[int32](44)
Console.WriteLine(CapacityOf[int32](numbers))`
        Assert.Equal("44${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func PropertyWriteUsesClosedReceiver() {
        let source = `import System.Collections.Generic

func SetCapacity[T](items List[T]) {
    items.Capacity = 55
}

var numbers = List[int32]()
SetCapacity[int32](numbers)
Console.WriteLine(numbers.Capacity)`
        Assert.Equal("55${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IndexReadUsesClosedReceiver() {
        let source = `import System.Collections.Generic

func First[T](items List[T]) T {
    return items[0]
}

var numbers = List[int32]()
numbers.Add(66)
Console.WriteLine(First[int32](numbers))`
        Assert.Equal("66${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IndexWriteUsesClosedReceiver() {
        let source = `import System.Collections.Generic

func SetFirst[T](items List[T], value T) {
    items[0] = value
}

var numbers = List[int32]()
numbers.Add(1)
SetFirst[int32](numbers, 77)
Console.WriteLine(numbers[0])`
        Assert.Equal("77${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func ClassTypeParameterUsesClosedReceiver() {
        let source = `import System.Collections.Generic

class Holder[T any] {
    func CountOf(items List[T]) int32 {
        return items.Count
    }
}

var holder = Holder[int32]()
var numbers = List[int32]()
numbers.Add(1)
numbers.Add(88)
Console.WriteLine(holder.CountOf(numbers))`
        Assert.Equal("2${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func StaticClassTypeParameterUsesClosedContainer() {
        let source = `import System.Collections.Generic

class Holder[T any] {
    shared {
        func CountOf(items List[T]) int32 {
            return items.Count
        }
    }
}

var numbers = List[int32]()
numbers.Add(1)
numbers.Add(2)
numbers.Add(3)
numbers.Add(4)
Console.WriteLine(Holder[int32].CountOf(numbers))`
        Assert.Equal("4${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func DeferredClosureRetainsTypeArguments() {
        let source = `import System.Collections.Generic

func MakeCounter[T]() (List[T]) -> int32 {
    return func(items List[T]) int32 {
        return items.Count
    }
}

var counter = MakeCounter[int32]()
var numbers = List[int32]()
numbers.Add(1)
numbers.Add(99)
Console.WriteLine(counter(numbers))`
        Assert.Equal("2${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func DeferredMethodGroupRetainsClassTypeArguments() {
        let source = `import System.Collections.Generic

class Holder[T any] {
    func Count(items List[T]) int32 {
        return items.Count
    }
}

func GetCounter[T](holder Holder[T]) (List[T]) -> int32 {
    return holder.Count
}

var holder = Holder[int32]()
var counter = GetCounter[int32](holder)
var numbers = List[int32]()
numbers.Add(1)
numbers.Add(2)
numbers.Add(3)
Console.WriteLine(counter(numbers))`
        Assert.Equal("3${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func DeferredMethodGroupRetainsClassTypeArgumentsAtReferenceType() {
        let source = `import System.Collections.Generic

class Holder[T any] {
    func Count(items List[T]) int32 {
        return items.Count
    }
}

func GetCounter[T](holder Holder[T]) (List[T]) -> int32 {
    return holder.Count
}

var holder = Holder[string]()
var counter = GetCounter[string](holder)
var words = List[string]()
words.Add("a")
words.Add("b")
Console.WriteLine(counter(words))`
        Assert.Equal("2${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func DeferredMethodGroupOverloadPickRetainsClassTypeArguments() {
        // Issue #3248 (overload path): a multi-candidate group defers overload
        // selection to the target-typed conversion, which closes each candidate
        // signature through the receiver's construction.
        let source = `import System.Collections.Generic

class Holder[T any] {
    func Count(items List[T]) int32 {
        return items.Count
    }

    func Count(items List[T], extra int32) int32 {
        return items.Count + extra
    }
}

func GetCounter[T](holder Holder[T]) (List[T]) -> int32 {
    return holder.Count
}

var holder = Holder[int32]()
var counter = GetCounter[int32](holder)
var numbers = List[int32]()
numbers.Add(4)
numbers.Add(5)
Console.WriteLine(counter(numbers))`
        Assert.Equal("2${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func DeferredMethodGroupThroughBaseChainRetainsClassTypeArguments() {
        // Issue #3248 (base-chain shape): the candidate is declared on the
        // generic base, so the substitution owner is resolved along the
        // receiver's base chain.
        let source = `import System.Collections.Generic

open class Base[T any] {
    func Count(items List[T]) int32 {
        return items.Count
    }
}

class Derived[T any] : Base[T] {
}

func GetCounter[T](d Derived[T]) (List[T]) -> int32 {
    return d.Count
}

var d = Derived[int32]{}
var counter = GetCounter[int32](d)
var numbers = List[int32]()
numbers.Add(7)
Console.WriteLine(counter(numbers))`
        Assert.Equal("1${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func DeferredMethodGroupNaturalTypeRetainsClassTypeArguments() {
        // Issue #3248 (natural-type shape): the group materializes into a
        // `var` local (no conversion target), so the natural FunctionType
        // built at member lookup must already carry the receiver's
        // instantiation.
        let source = `import System.Collections.Generic

class Holder[T any] {
    func Count(items List[T]) int32 {
        return items.Count
    }
}

func GetCount[T](holder Holder[T], items List[T]) int32 {
    var counter = holder.Count
    return counter(items)
}

var holder = Holder[int32]()
var numbers = List[int32]()
numbers.Add(1)
numbers.Add(2)
Console.WriteLine(GetCount[int32](holder, numbers))`
        Assert.Equal("2${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func StaticPropertyWriteUsesClosedContainer() {
        let source = `import GSharp.Interpreter.Tests.ProbeRef

func Marker() int32 {
    return 111
}

func SetValue[T]() {
    GenericStaticSlot[T].Value = Marker()
}

SetValue[int32]()
Console.WriteLine(GenericStaticSlot[int32].Value)`
        Assert.Equal("111${Environment.NewLine}", RunSubmission(source))
    }

    shared {
        private func RunSubmission(text string) string {
            using let outWriter = StringWriter()
            let prevOut = Console.Out
            Console.SetOut(outWriter)
            try {
                let repl = GSharpRepl()
                repl.EvaluateSubmission(text)
            } finally {
                Console.SetOut(prevOut)
            }
            return outWriter.ToString().ReplaceLineEndings(Environment.NewLine)
        }
    }
}
