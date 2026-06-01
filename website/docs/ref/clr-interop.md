---
title: "CLR interop reference"
sidebar_position: 3
draft: false
---

# CLR interop reference

G# targets the CLR directly. Imported .NET types are first-class in binding, evaluation, and emit: constructors, methods, fields, properties, indexers, events, delegates, operators, conversions, attributes, and generic metadata are all represented in the bound model. This page describes the implemented surface; P/Invoke and `extern` bodies are explicitly not supported today.

## Imports and type names

Use `import` to bring a namespace into scope, or use an alias to shorten or disambiguate a namespace.

```gsharp
package Example

import System
import Collections = System.Collections.Generic

var list = Collections.List[int32]()
Console.WriteLine(list.Count)
```

The compiler adds an implicit `System` import by default, so `Console.WriteLine(...)` can resolve without `import System`. Pass `/noimplicitimports` or `/no-implicit-imports` to disable that behavior. CLR primitive types map to G# built-in names where possible; other CLR types are imported type symbols.

## Constructing imported types

Imported constructors can be called with a simple type name when the type is imported, or with a qualified name when qualification is needed. Generic type arguments use G# bracket syntax.

```gsharp
import System.Collections.Generic

var list = List[int32]()
list.Add(42)

var dict = Dictionary[string, int32]()
dict["answer"] = 42
```

Constructor overload resolution uses the same imported member machinery as method calls, including numeric conversion ranking and optional/default argument support where metadata supplies defaults.

## Members and overloads

Imported instance members use ordinary member syntax. Static members are accessed through the imported type. Properties and indexers bind as property/index expressions or assignments.

```gsharp
import System
import System.Collections.Generic

var text = "gsharp"
Console.WriteLine(text.Length)

var counts = Dictionary[string, int32]()
counts["g"] = 1
Console.WriteLine(counts.ContainsKey("g"))
```

Overload resolution considers imported methods, constructors, conversion operators, optional/default parameters, and numeric better-conversion tie breaking. Named arguments are parsed generally and are accepted for imported optional/default argument scenarios.

## Extension methods

G# receiver functions are declared with `func (receiver T) Name(...) ...`. Imported CLR extension methods marked with `[Extension]` can also dispatch through instance syntax when their containing namespace is imported.

```gsharp
import System
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)
list.Add(3)

var oddsAndEvens = list.CountBy(func(x int32) int32 { return x % 2 })
for kv in oddsAndEvens {
    Console.WriteLine(kv.Value)
}
```

The sample above relies on an imported extension method whose trailing optional comparer argument is omitted.

## Delegates, function literals, and method groups

A G# function literal can convert to a compatible CLR delegate type, including named delegate types and the standard `Action[...]`, `Func[...]`, and `Predicate[...]` families. Method groups can convert to delegates when the target delegate signature is known. Delegate values and G# function values can also widen to `System.Delegate` and `System.MulticastDelegate`.

```gsharp
import System

var handler = func(sender object, e EventArgs) {
    Console.WriteLine("called")
}
```

Interpreter limitation: function-literal-to-delegate marshalling for some imported delegate scenarios is an emit-path feature. The evaluator supports G# closure values and many reflection calls, but delegate materialization is not identical to emitted IL in every case.

## Events

CLR and G# events use `+=` to subscribe and `-=` to unsubscribe. The right-hand side must be convertible to the event delegate type.

```gsharp
import System

var domain = AppDomain.CurrentDomain
domain.ProcessExit += func(sender object, e EventArgs) {
    Console.WriteLine("process exiting")
}
```

Event accessors on user types are declared with the G# `event` member form; imported CLR events bind through reflection metadata.

## Operator overloads and conversions

Imported CLR operator overloads and conversion operators participate in binding. User-defined G# operator declarations use receiver syntax and map to CLR `op_*` names for emit and interop.

```gsharp
type Vec class {
    X int32
    Y int32
}

func (v Vec) operator +(other Vec) Vec {
    return Vec{X: v.X + other.X, Y: v.Y + other.Y}
}
```

Built-in primitive operators remain table-driven and do not rely on imported operator metadata.

## Attributes and annotations

G# uses Kotlin-style annotation syntax for CLR attributes:

```gsharp
@Obsolete("use NewName")
func OldName() {
}

@Attribute
type Trace class {
}
```

Annotation names resolve either to the exact type name or to the conventional `Attribute` suffix form. Use-site targets include `field`, `param`, `return`, `type`, `method`, `property`, `event`, `module`, `assembly`, and `genericparam`. Arguments must be compile-time constants supported by CLR attribute metadata. `@Attribute` is declaration sugar for attribute classes and implies a `System.Attribute` base class.

Compiler-synthesized attributes such as `CompilerGenerated`, `Extension`, `AsyncStateMachine`, `Nullable`, and `NullableContext` are reserved. `[DllImport]` is recognized but unsupported for v1.0; using it reports `GS0211`.

## By-ref and pointer surface

The by-ref/pointer interop surface is intentionally narrow today:

| Surface | Meaning |
| --- | --- |
| `*T` | By-ref/pointer type clause syntax. |
| `&expr` | Address-of expression. |
| `*expr` | Dereference expression. |
| `ref` arguments | Required for CLR `ref`, `out`, or `in` parameter calls when the binder demands it. |

Diagnostics `GS9001` through `GS9006` cover non-lvalue address-of, missing `ref`, definite assignment before `ref`, ref escape, constants, and pointer fields. The evaluator does not implement generic address-of/dereference execution, so this surface is primarily for emit and CLR interop.

## Generics interop

Imported generic types and methods use G# bracket syntax:

```gsharp
import System.Collections.Generic

var xs = List[int32]()
```

G# emits metadata specs for constructed generic types and methods, supports type-argument inference for imported open generic methods, and supports variance markers and constraints in its own type parameter model. The current implementation also has a type-erased generic model for some open or partially constructed shapes that contain type parameters; those shapes may be represented as `object` in emit paths. Treat this as an implementation constraint rather than a source-level API.

## Interpolated strings and formatting

Interpolated string literals are sigil-free in G# — holes (`$name`, `${expr}`, `${expr,alignment:format}`) live inside ordinary `"…"` strings — but their lowering is CLR formatting interop. The target type drives which formatting type is used:

- By default an interpolated string lowers to `System.Runtime.CompilerServices.DefaultInterpolatedStringHandler`. The handler is a `ref struct`, so value-typed holes are appended without boxing, and the result is materialized with `ToStringAndClear()`.
- When the contextual target type is `System.IFormattable` or `System.FormattableString`, the string lowers to `FormattableStringFactory.Create(format, args)` instead of an eager `string`. Formatting is deferred, so the caller chooses the culture via `ToString(IFormatProvider)`. This applies in `let`/`return`/cast contexts and when the interpolation is passed directly as an argument to a `FormattableString` parameter.
- A parameter annotated with `[InterpolatedStringHandler]` receives the handler value directly, and `[InterpolatedStringHandlerArgument]` forwarding is honored when the handler constructor requests additional arguments.

```gsharp title="samples/InterpolatedStringFormattable.gs"
import System
import System.Globalization

func renderInvariant(fs FormattableString) string {
    return fs.ToString(CultureInfo.InvariantCulture)
}

let total = 1234.5
let qty = 7
let fs FormattableString = "amount: ${total:N2} (x${qty,4})"

Console.WriteLine(fs.ToString(CultureInfo.InvariantCulture))
Console.WriteLine(fs.ToString(CultureInfo.GetCultureInfo("de-DE")))
```

Alignment (`,4`) and format (`:N2`) clauses are preserved in the synthesized composite format string, so the same `FormattableString` renders differently under different cultures. The grammar and diagnostics for holes are documented in the [language specification](./spec.md#string-literals).

## Unsupported interop surface

The following are not implemented as source features today: P/Invoke/`extern` methods, user-authored `[DllImport]` bodies, default parameter values in G# declarations, and C#-style `null` literals. Use `nil` for nullable values and import .NET APIs for library functionality.
