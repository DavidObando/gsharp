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

## By-ref pointers (`&` / `*` / `*T`)

G# has a managed by-ref surface that lets you call CLR methods with `ref`, `out`, and `in` parameters. It is implemented end-to-end in binding and emit (per [ADR-0039](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0039-byref-pointers-and-clr-interop.md)): taking the address of a local and passing it to a `ref`/`out` parameter compiles to `ldloca` and runs.

| Surface | Meaning |
| --- | --- |
| `&x` | Address-of: produces a managed pointer to the lvalue `x`, used to pass `ref` / `out` / `in` arguments. |
| `*p` | Dereference: reads or writes through a managed pointer `p`. |
| `*T` | The managed-pointer (by-ref) type, equivalent to C#'s `ref T` at a parameter or local level. |

Taking an address with `&` requires an lvalue — a local, parameter, field, or array element. The address-of operand is what makes the argument flow by reference at the call site, so `&` is written explicitly at CLR `ref`/`out`/`in` call sites:

```gsharp
import System

var result = 0
var ok = Int32.TryParse("42", &result)
if ok {
    Console.WriteLine(result)
}
```

The same `&` form drives any `ref`/`out` BCL API, for example `Interlocked.CompareExchange`:

```gsharp
import System
import System.Threading

var counter = 0
Interlocked.CompareExchange(&counter, 1, 0)
Console.WriteLine(counter)
```

`out` variables need not be definitely assigned before the call: passing `&result` at an `out` position is allowed even when `result` was never written, and after the call the variable is considered definitely assigned. Variables passed at a `ref` (not `out`) position must already be definitely assigned.

At the CLR metadata level, `*T` maps to `ELEMENT_TYPE_BYREF` — a managed reference, the same encoding as C#'s `ref T` — and not to `ELEMENT_TYPE_PTR` (an unmanaged pointer). No unmanaged-pointer semantics (arithmetic, pinning, `fixed`) are implied.

### Limitations

The by-ref surface is deliberately scoped to managed references for CLR interop. Per ADR-0039 the following are out of scope today: unmanaged pointers, pointer arithmetic, and `unsafe` blocks; by-ref returns from G# functions (`func foo() *int { return &x }`); and the full Roslyn-style `ref-safe-to-escape` / `safe-to-escape` two-level escape analysis, which is deferred to [issue #376](https://github.com/DavidObando/gsharp/issues/376). V1 uses a simpler rule: by-ref values cannot escape their declaring scope.

### Diagnostics

| Diagnostic | Reported when |
| --- | --- |
| `GS9001` | `&` is applied to a non-lvalue expression. |
| `GS9002` | A `ref`/`out`/`in` argument is missing the required `&` at the call site. |
| `GS9003` | A variable is passed at a `ref` (not `out`) position before being definitely assigned. |
| `GS9004` | A by-ref value would escape its declaring scope (captured in a lambda, returned, or stored in a field). |
| `GS9005` | `&` is applied to a constant. |
| `GS9006` | A pointer (`*T`) type is used as a field type. |

## Spans and `ref struct` types

G# can consume CLR `ref struct` types — most importantly `System.Span[T]` and `System.ReadOnlySpan[T]` — as ordinary stack-only locals, parameters, and fields. The consumption surface is defined by [ADR-0056](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0056-span-consumption-v1.md) and builds on the by-ref machinery above.

A by-ref-like (`ref struct`) value carries `System.Runtime.CompilerServices.IsByRefLikeAttribute` and is stack-only: the CLR forbids any use that would let it reach the heap. G# enforces this with **`GS0219`** — boxing or converting it to a reference type, storing it in a non-`ref struct` field, capturing it in a closure, hoisting it into an `async`/iterator state machine, using it as a generic type argument, or declaring it as a top-level global are all rejected. Because of the last rule, span locals live inside functions.

### Span element access

A `Span[T]` / `ReadOnlySpan[T]` indexer returns a managed pointer (`ref T` / `ref readonly T`). Reading an element in rvalue position **auto-dereferences** the ref return to the pointee `T` (you do not write `*`), and a `Span[T]` element write `s[i] = v` stores through the returned `ref T`:

```gsharp
import System

func sumSpan(values []int32) int32 {
    var s ReadOnlySpan[int32] = values   // []T -> ReadOnlySpan[T] implicit conversion
    var total = 0
    var i = 0
    for i < s.Length {
        total = total + s[i]             // read auto-dereferences ref readonly int32 -> int32
        i = i + 1
    }
    return total
}

func writeBack(values []int32) int32 {
    var s Span[int32] = values
    s[0] = 100                           // store through the ref int32 from get_Item
    s[2] = 300
    return s[0] + s[1] + s[2]
}
```

A `ReadOnlySpan[T]` element is `ref readonly T`, so writing through it is a hard error — **`GS0226`** (`s[0] = 1` on a `ReadOnlySpan[T]`); reading it is always allowed. Auto-dereference is the same general rule for every ref-returning CLR member (indexers, `ref` property getters, ref-returning methods): **ref returns auto-dereference in rvalue position; taking an address still requires `&`.**

### Slice-to-span conversion

A `[]T` slice converts implicitly to `Span[T]` / `ReadOnlySpan[T]` (via the BCL's `op_Implicit`) at local initialization **and** in argument position, so a slice flows straight into a span-typed BCL or user API without an explicit cast.

### Closed generic value-type fields

A user `ref struct` may embed a **closed** constructed generic value-type field, such as a span:

```gsharp
import System

type Window ref struct {
    data ReadOnlySpan[int32]
}

func firstLen(w Window) int32 {
    return w.data.Length
}
```

Such a field is emitted with its real layout (`valuetype ReadOnlySpan<int32>`, never erased to `System.Object`), and instance-member calls on the field receiver take its address correctly. Type erasure (see [Generics interop](#generics-interop)) applies only to *open*, type-parameter-bearing shapes; closed value-type generics in field position carry real layout.

### Limitations

Per ADR-0056, the following remain out of scope: by-ref returns from G# functions and the full two-level `ref-safe-to-escape` analysis (`scoped`, `[UnscopedRef]`), deferred to [issue #376](https://github.com/DavidObando/gsharp/issues/376); open generic value-type `ref struct` fields (`type Buffer[T] ref struct { data ReadOnlySpan[T] }`); `stackalloc` and other span-*creation* primitives; and a lowercase `span[T]` alias (spans are imported CLR types `Span[T]` / `ReadOnlySpan[T]`, requiring `import System`).

## Generics interop

Imported generic types and methods use G# bracket syntax:

```gsharp
import System.Collections.Generic

var xs = List[int32]()
```

G# emits metadata specs for constructed generic types and methods, supports type-argument inference for imported open generic methods, and supports variance markers and constraints in its own type parameter model. The current implementation also has a type-erased generic model for some open or partially constructed shapes that contain type parameters; those shapes may be represented as `object` in emit paths. Closed constructed generic *value* types (e.g. `ReadOnlySpan[int32]`, `Nullable[int32]`) are an exception: in field position they carry their real layout and are never erased (see [Spans and `ref struct` types](#spans-and-ref-struct-types)). Treat the open-shape erasure as an implementation constraint rather than a source-level API.

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
