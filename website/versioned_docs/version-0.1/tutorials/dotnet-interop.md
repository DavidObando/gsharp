---
title: "Tutorial: .NET interop"
sidebar_position: 7
draft: false
---

# Tutorial: .NET interop

In this tutorial, you will import CLR namespaces, call constructors and methods, subscribe to events, pass delegates, use extension functions, and rely on operator overloads.

:::note
Passing G# func literals to imported CLR methods works on the compiler emit path, such as SDK builds or `gsc /out`. It does not work in the interpreter path used when `gsc` runs without `/out`.
:::

## Prerequisites

- A working G# SDK project or `gsc /out` command line.
- Familiarity with .NET namespaces and assemblies.

## 1. Import CLR namespaces

`import System` brings CLR types such as `Console` and `DateTime` into scope. The import can be implicit in samples that exercise default platform imports:

```gsharp title="ImplicitImport.gs"
// file: ImplicitImport.gs
// Phase 1.5: Console resolves without an explicit `import System`.

package ImplicitImport

Console.WriteLine("Hello without import!")
```

Expected output:

```text
Hello without import!
```

Aliases disambiguate long namespace names:

```gsharp title="ImportAlias.gs"
// file: ImportAlias.gs

package ImportAlias

import sys = System

sys.Console.WriteLine("Hello from alias!")
```

Expected output:

```text
Hello from alias!
```

## 2. Construct and inherit CLR-facing classes

G# classes can inherit imported base classes and call base constructors:

```gsharp title="ImportedBaseClass.gs"
// file: ImportedBaseClass.gs
// Issue #296: a GSharp `class` can inherit from an IMPORTED (CLR) base class.
// Previously `class X : SomeImportedType { }` reported GS0157
// "Cannot find type" even though the type resolved for construction / static
// use. This sample proves the full scenario end-to-end:
//   * base-type name resolution against imported CLR types (simple + qualified)
//   * the emitted class extends the imported base in metadata
//   * base construction chains to the imported parameterless ctor
//   * inherited members (methods AND properties) are accessible on instances

package GSharp.Example.ImportedBaseClass

import System
import System.IO

// `Buffer` extends System.IO.MemoryStream via a simple (import-resolved) name.
// It also declares its own method alongside the inherited surface.
class Buffer : MemoryStream {
    func Describe(label string) string {
        return label
    }
}

var b = Buffer{}

// Inherited properties from the CLR base are visible on the GSharp instance.
Console.WriteLine(b.CanRead)
Console.WriteLine(b.CanWrite)

// Inherited method with an argument (int32 widened to the base's int64 param).
b.SetLength(3)
Console.WriteLine(b.Length)

// Inherited no-argument method returning a value.
var bytes = b.ToArray()
Console.WriteLine(bytes.Length)

// User-declared method on the derived class coexists with the inherited members.
Console.WriteLine(b.Describe("buffer"))

// A fully-qualified imported base type also resolves.
class Args : System.EventArgs {
}

var a = Args{}
Console.WriteLine(a.ToString())
```

Expected output:

```text
True
True
3
3
buffer
GSharp.Example.ImportedBaseClass.Args
```

## 3. Add extension functions

An extension function lowers to a CLR extension method. Static extension containers are generated so C# and LINQ-style consumers can see the method:

```gsharp title="ExtensionFunctions.gs"
// file: ExtensionFunctions.gs
// Phase 3.B.6 / ADR-0019: extension functions. A Go-style receiver clause
// `func (recv T) Name(args) ret { ... }` declares a function that is
// invoked at the call site as if it were an instance method on the
// receiver type. Extensions apply to types owned by another package, CLR
// types, and primitives. Same-package user types now bind as methods with
// receivers (Phase 6.4).

package GSharp.Example.ExtensionFunctions

import System

func (value int32) Abs() int32 {
    if value < 0 {
        return -value
    }

    return value
}

func (value int32) Scale(factor int32) int32 {
    return value * factor
}

var n = -7
var one = 1
Console.WriteLine(n.Abs())
Console.WriteLine(one.Scale(10))
```

Expected output:

```text
7
10
```

Generic extension functions use bracket type parameters:

```gsharp title="GenericExtensionFunctions.gs"
// file: GenericExtensionFunctions.gs
// Issue #326: extension functions can declare type parameters. A Go-style
// receiver clause `func (recv R) Name[T](args) ret { ... }` combines the
// extension-function form (Phase 3.B.6 / ADR-0019) with generic type
// parameters (Phase 4.1 / ADR-0020). Type arguments are resolved either by
// inference from the call-site arguments or from an explicit `[T]` list.

package GSharp.Example.GenericExtensionFunctions

import System

// Single type parameter, inferred or explicit.
func (value int32) Echo[T](item T) T {
    return item
}

// The receiver is ignored; the second argument's type is dropped.
func (value int32) PickFirst[T, U](a T, b U) T {
    return a
}

var n = 5

// Inference from the argument type.
Console.WriteLine(n.Echo(42))
Console.WriteLine(n.Echo("hello"))

// Explicit type arguments.
Console.WriteLine(n.Echo[int32](7))
Console.WriteLine(n.Echo[string]("world"))

// Multiple type parameters, inferred.
Console.WriteLine(n.PickFirst(99, "ignored"))
Console.WriteLine(n.PickFirst[string, int32]("kept", 0))
```

Expected output:

```text
42
hello
7
world
99
kept
```

You can also call imported LINQ extension methods from G#:

```gsharp title="LinqExtensions.gs"
// file: LinqExtensions.gs
// Issue #294: BCL/library [Extension] methods are callable with instance
// ("receiver") syntax, e.g. `sequence.Where(pred)`, not only statically as
// `Enumerable.Where(sequence, pred)`. System.Linq.Enumerable extension methods
// over IEnumerable<T> exercise generic type inference from the receiver and
// from the predicate/projection arguments.

package GSharp.Example.LinqExtensions

import System
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)
list.Add(3)
list.Add(4)
list.Add(5)
list.Add(6)

// Single generic extension method, type inferred from the receiver.
var evens = list.Where(func(x int32) bool { return x % 2 == 0 })
for v in evens {
    Console.WriteLine(v)
}

// Chained generic extension methods: Where -> Select.
var doubledEvens = list.Where(func(x int32) bool { return x % 2 == 0 }).Select(func(x int32) int32 { return x * 10 })
for v in doubledEvens {
    Console.WriteLine(v)
}

// Terminal aggregate extension methods.
Console.WriteLine(list.Where(func(x int32) bool { return x > 3 }).Count())
Console.WriteLine(list.Sum())
```

Expected output:

```text
2
4
6
20
40
60
3
21
```

## 4. Subscribe to events

Events use `+=` and `-=` with delegate-compatible handlers:

```gsharp title="EventSubscription.gs"
// file: EventSubscription.gs
// Stream B′ demo: subscribing to a CLR event with `+=` and unsubscribing
// with `-=`. Function literals automatically materialize as the event's
// declared delegate type when their signature matches.

package GSharp.Example.EventSubscription

import System

var domain = AppDomain.CurrentDomain

domain.ProcessExit += func(sender Object, e EventArgs) {
    Console.WriteLine("would only fire if not removed")
}

Console.WriteLine("subscribed")
```

Expected output:

```text
subscribed
would only fire if not removed
```

## 5. Convert functions to delegates

A G# func literal can convert to a delegate on the emit path:

```gsharp title="FuncToDelegate.gs"
// file: FuncToDelegate.gs
//
// Issue #295 (related to #255): a GSharp function value converts to a
// compatible CLR delegate type in ALL positions, not only as a direct call
// argument. This sample exercises the previously-rejected assignment and
// return positions (which used to fail with `error GS0155`), plus a
// func-typed value adapted to a named delegate type. The resulting delegates
// are invoked to prove the materialization is correct at runtime.

package GSharp.Samples.FuncToDelegate

import System

// Return position: a factory that RETURNS a delegate built from a func literal.
func makeDoubler() Func[int32, int32] {
    return func(x int32) int32 { return x * 2 }
}

// Assignment position: a func literal assigned to a named generic delegate.
var isBig Predicate[int32] = func(x int32) bool { return x > 2 }

// Assignment position: a func literal assigned to a parameterless delegate.
var greet Action = func() { Console.WriteLine("hello from Action") }

// A func-typed value adapted to a named delegate type (delegate adaptation).
var raw = func(x int32) int32 { return x + 100 }
var bump Func[int32, int32] = raw

var doubler = makeDoubler()

Console.WriteLine(doubler.Invoke(21))
Console.WriteLine(isBig.Invoke(5))
Console.WriteLine(isBig.Invoke(1))
greet.Invoke()
Console.WriteLine(bump.Invoke(1))
```

Expected output:

```text
42
True
False
hello from Action
101
```

System delegate types work too:

```gsharp title="FuncToSystemDelegate.gs"
// file: FuncToSystemDelegate.gs
//
// Issue #323: a Func[...] (or native func(...)) value widens implicitly to
// System.Delegate (the common base of every delegate). This used to fail with
// `error GS0155`. Both forms are exercised:
//   * the var form: a named/generic delegate value assigned to a Delegate slot
//   * the lambda-literal form: a func literal assigned directly to a Delegate
// The resulting System.Delegate values expose their target method, proving the
// widening is a correct reference upcast at runtime.

package GSharp.Samples.FuncToSystemDelegate

import System

// var form: a named generic delegate value widens to System.Delegate.
var f Func[string] = func() string { return "hi" }
var d Delegate = f

// lambda-literal form: a func literal assigned straight to a Delegate slot.
var g Delegate = func() string { return "yo" }

Console.WriteLine(d.Method.Name)
Console.WriteLine(g.Method.Name)
```

Expected output:

```text
<lambda1>
<lambda2>
```

Method groups can convert to delegates, both for G# methods and CLR methods:

```gsharp title="MethodGroupToDelegate.gs"
// file: MethodGroupToDelegate.gs
// Issue #324: a named function used as a method group converts directly to a
// delegate value, mirroring the C#/F# idiom. This sample exercises every
// supported target shape: a generic `Func[...]`, the native `func(...)` type,
// passing a method group as a callback argument, and an `Action[...]` (void
// return). No lambda wrapping is required.

package GSharp.Example.MethodGroupToDelegate

import System

func inc(x int32) int32 {
    return x + 1
}

func twice(x int32) int32 {
    return x * 2
}

func apply(g func(int32) int32, v int32) int32 {
    return g(v)
}

func shout(message string) {
    Console.WriteLine(message)
}

// Method group -> generic Func[...] delegate.
var f Func[int32, int32] = inc
Console.WriteLine(f.Invoke(41))

// Method group -> native func(...) delegate, invoked directly.
var nf func(int32) int32 = twice
Console.WriteLine(nf(21))

// Method group passed as a callback argument.
Console.WriteLine(apply(inc, 9))

// Method group -> Action[...] delegate (void return).
var a Action[string] = shout
a.Invoke("method groups work")
```

Expected output:

```text
42
42
10
method groups work
```

```gsharp title="ClrMethodGroupToDelegate.gs"
// file: ClrMethodGroupToDelegate.gs
// Issue #337: a CLR member method group converts directly to a delegate value,
// mirroring the named-function method-group support from #324/#332. This
// sample exercises every supported shape:
//   * a static member group on an imported type (Console.WriteLine, Int32.Parse),
//   * an instance member group that captures its receiver (StringBuilder.Append),
//   * overload selection driven by the target delegate signature.

package GSharp.Example.ClrMethodGroupToDelegate

import System
import System.Text

// Static member method group -> Action[string] (void return). Overload
// selection picks WriteLine(string) among Console.WriteLine's many overloads.
var write Action[string] = Console.WriteLine
write.Invoke("hello from a static method group")

// Static member method group -> Func[string, int32]. Int32.Parse(string) is
// selected by the target signature.
var parse Func[string, int32] = Int32.Parse
Console.WriteLine(parse.Invoke("41") + 1)

// Instance member method group -> Func[string, StringBuilder]. The receiver
// `sb` is captured as the delegate target; Append(string) is selected.
var sb = StringBuilder()
var append Func[string, StringBuilder] = sb.Append
append.Invoke("instance ")
append.Invoke("method ")
append.Invoke("group")
Console.WriteLine(sb.ToString())
```

Expected output:

```text
hello from a static method group
42
instance method group
```

Delegate invocation uses normal call syntax:

```gsharp title="DelegateCallSyntax.gs"
// file: DelegateCallSyntax.gs
//
// Issue #325: a variable whose type is a CLR delegate (e.g. `Func[...]`,
// `Predicate[...]`, `Action`) is invocable with call syntax `f(x)`, exactly
// like a native G# func-typed variable. Previously this required the explicit
// `.Invoke(...)` form and `f(x)` failed with `GS0131: 'f' is not a function`.
// Each delegate below is invoked through call syntax to prove the lowering to
// `Invoke` is correct at runtime.

package GSharp.Samples.DelegateCallSyntax

import System

// Generic Func delegate invoked via call syntax.
var increment Func[int32, int32] = func(x int32) int32 { return x + 1 }
Console.WriteLine(increment(41))

// Two-argument Func delegate invoked via call syntax.
var add Func[int32, int32, int32] = func(a int32, b int32) int32 { return a + b }
Console.WriteLine(add(20, 22))

// Predicate delegate invoked via call syntax.
var isBig Predicate[int32] = func(x int32) bool { return x > 2 }
Console.WriteLine(isBig(5))
Console.WriteLine(isBig(1))

// Parameterless Action delegate invoked via call syntax.
var greet Action = func() { Console.WriteLine("hello from Action") }
greet()

// Call syntax and Invoke produce the same result.
Console.WriteLine(increment(9))
Console.WriteLine(increment.Invoke(9))
```

Expected output:

```text
42
42
True
False
hello from Action
10
10
```

## 6. Use operators and optional arguments

Imported CLR operators bind through ordinary G# operators:

```gsharp title="Operators.gs"
// file: Operators.gs
// Stream D / ADR-0035: receiver-form `operator` keyword on a GSharp struct.
// Defines binary `+`, binary `==` / `!=`, and unary `-` on Vector2 and uses
// them at call sites just like built-in operator syntax.
package GSharp.Sample.Operators

import System

class Vector2 {
    X int32
    Y int32
}

func (a Vector2) operator +(b Vector2) Vector2 {
    return Vector2{X: a.X + b.X, Y: a.Y + b.Y}
}

func (a Vector2) operator -() Vector2 {
    return Vector2{X: -a.X, Y: -a.Y}
}

func (a Vector2) operator ==(b Vector2) bool {
    return a.X == b.X && a.Y == b.Y
}

func (a Vector2) operator !=(b Vector2) bool {
    return a.X != b.X || a.Y != b.Y
}

var p = Vector2{X: 1, Y: 2}
var q = Vector2{X: 3, Y: 4}
var r = p + q
var n = -p

Console.WriteLine(r.X)
Console.WriteLine(r.Y)
Console.WriteLine(n.X)
Console.WriteLine(n.Y)
Console.WriteLine(p == q)
Console.WriteLine(p != q)
Console.WriteLine(p == Vector2{X: 1, Y: 2})
```

Expected output:

```text
4
6
-1
-2
False
True
True
```

Optional CLR arguments can be omitted at the call site. G# user-defined functions do not have default parameter values, but imported CLR metadata does:

```gsharp title="OptionalExtensionArgs.gs"
// file: OptionalExtensionArgs.gs
// Issue #327: imported [Extension] methods with trailing optional/default
// parameters are callable while omitting those arguments. Mirrors
// HttpResponse.WriteAsync(text) — whose string-only overload has a
// `CancellationToken cancellationToken = default` trailing parameter — using
// the dependency-free System.Linq.Enumerable.CountBy<TSource,TKey>(
//   this IEnumerable<TSource> source,
//   Func<TSource,TKey> keySelector,
//   IEqualityComparer<TKey> comparer = null)
// extension, called with only the key selector (the optional comparer omitted).

package GSharp.Example.OptionalExtensionArgs

import System
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)
list.Add(3)
list.Add(4)
list.Add(5)
list.Add(6)

// CountBy groups by the key selector; the optional comparer argument is
// omitted, so it must resolve to the trailing-optional overload.
var counts = list.CountBy(func(x int32) int32 { return x % 2 })
for kv in counts {
    Console.WriteLine(kv.Key)
    Console.WriteLine(kv.Value)
}
```

Expected output:

```text
1
3
0
3
```

## What you learned

- Imports bind both G# packages and CLR namespaces.
- Constructors, inheritance, properties, events, operators, and extension methods are available from CLR metadata.
- G# function values and method groups can become delegates on the emit path.
- Interpreter-only runs do not support passing G# func literals to imported CLR methods; use SDK builds or `gsc /out` for that scenario.
