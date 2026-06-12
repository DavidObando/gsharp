---
title: "CLR interop reference"
sidebar_position: 3
draft: false
---

# CLR interop reference

G# targets the CLR directly. Imported .NET types are first-class in binding, evaluation, and emit: constructors, methods, fields, properties, indexers, events, delegates, operators, conversions, attributes, and generic metadata are all represented in the bound model. P/Invoke is supported through the `@DllImport` attribute on a `;`-body `func` declaration (ADR-0086); see [Unmanaged interop (P/Invoke)](#unmanaged-interop-pinvoke) below.

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

Overload resolution considers imported methods, constructors, conversion operators, optional/default parameters (G# and CLR-supplied), ref-kind matching, numeric better-conversion tie breaking, and overload sets on user functions (ADR-0063). Named arguments are accepted at the call site (`F(timeout: 30)`) for free functions, user methods, user constructors, extension functions, and inherited CLR methods (including delegate `Invoke`); indirect calls through a function-typed variable and variadic call sites do not accept names because the call target does not preserve parameter names. Diagnostics `GS0244`–`GS0247` and `GS0264`–`GS0267` cover the related failure modes.

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
class Vec {
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
class Trace {
}
```

Annotation names resolve either to the exact type name or to the conventional `Attribute` suffix form. Use-site targets include `field`, `param`, `return`, `type`, `method`, `property`, `event`, `module`, `assembly`, and `genericparam`. Arguments must be compile-time constants supported by CLR attribute metadata. `@Attribute` is declaration sugar for attribute classes and implies a `System.Attribute` base class.

Compiler-synthesized attributes such as `CompilerGenerated`, `Extension`, `AsyncStateMachine`, `Nullable`, and `NullableContext` are reserved. `@DllImport` opts a function into P/Invoke (see [Unmanaged interop (P/Invoke)](#unmanaged-interop-pinvoke) below); the historical blanket-rejection at `GS0211` no longer fires.

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

The by-ref surface is deliberately scoped to managed references for CLR interop. Per ADR-0039 the following are out of scope today: unmanaged pointers, pointer arithmetic, and `unsafe` blocks. By-ref returns from G# functions (`func f(...) ref T`) have since landed via ADR-0060's follow-up work (diagnostics `GS0248`–`GS0255`), and the `scoped` parameter modifier from [ADR-0058](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0058-ref-safe-to-escape.md) is wired up; the full Roslyn-style `ref-safe-to-escape` / `safe-to-escape` two-level escape analysis is still deferred to [issue #376](https://github.com/DavidObando/gsharp/issues/376). V1 uses a simpler rule: by-ref values cannot escape their declaring scope, and a `scoped` parameter cannot be returned.

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

ref struct Window {
    data ReadOnlySpan[int32]
}

func firstLen(w Window) int32 {
    return w.data.Length
}
```

Such a field is emitted with its real layout (`valuetype ReadOnlySpan<int32>`, never erased to `System.Object`), and instance-member calls on the field receiver take its address correctly. Type erasure (see [Generics interop](#generics-interop)) applies only to *open*, type-parameter-bearing shapes; closed value-type generics in field position carry real layout.

### Limitations

Per ADR-0056, the following remain out of scope: the full two-level `ref-safe-to-escape` analysis (including `[UnscopedRef]`), deferred to [issue #376](https://github.com/DavidObando/gsharp/issues/376) — though the `scoped` parameter modifier from [ADR-0058](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0058-ref-safe-to-escape.md) is wired up; open generic value-type `ref struct` fields (`ref struct Buffer[T] { data ReadOnlySpan[T] }`); `stackalloc` and other span-*creation* primitives; and a lowercase `span[T]` alias (spans are imported CLR types `Span[T]` / `ReadOnlySpan[T]`, requiring `import System`).

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

## Unmanaged interop (P/Invoke)

ADR-0086 / issue #727 adds attribute-driven P/Invoke. A `;` at the place of the body marks a function as having no managed body; when the function carries an `@DllImport("libname", ...)` annotation, the binder treats it as a P/Invoke stub and the emitter produces a CLR `PinvokeImpl` MethodDef row, an `ImplMap` row pointing at the deduplicated `ModuleRef` for `libname`, and (when requested) the `SetLastError` / `ExactSpelling` / charset / calling-convention bits.

```gsharp
package P
import System
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
func NativeStrLen(text string) nint;

@DllImport("libc", EntryPoint: "open", SetLastError: true)
func NativeOpen(path string, flags int32) int32;

Console.WriteLine(NativeStrLen("Hello, world!"))     // prints 13
var fd = NativeOpen("/no/such/file", 0)
Console.WriteLine(Marshal.GetLastWin32Error())      // POSIX errno propagated through the CLR
```

### Attribute knobs

| Name | Type | Default | Notes |
| --- | --- | --- | --- |
| Library name (positional) | `string` | required | The unmanaged library to resolve (passed to `dlopen` / `LoadLibrary`). |
| `EntryPoint` | `string` | function name | Native symbol to resolve. |
| `CharSet` | `System.Runtime.InteropServices.CharSet` | `Ansi` | Governs how `string` parameters and return values are marshalled. |
| `SetLastError` | `bool` | `false` | When `true`, the CLR captures `GetLastError` / `errno` and exposes it via `Marshal.GetLastWin32Error`. |
| `CallingConvention` | `CallingConvention` | `Winapi` | Maps to `MethodImportAttributes.CallingConvention*`. |
| `ExactSpelling` | `bool` | `CharSet == Auto` | When `false`, the CLR may probe for an `A`/`W` suffix. |
| `PreserveSig` | `bool` | `true` | When `false`, an HRESULT return becomes a thrown exception (COM-style). |
| `BestFitMapping` | `bool?` | unspecified | Tri-state best-fit mapping override. |
| `ThrowOnUnmappableChar` | `bool?` | unspecified | Tri-state unmappable-character behavior override. |

### Supported v1 marshalling types

Every primitive integer (`int8`/`16`/`32`/`64`, `uint8`/`16`/`32`/`64`), `nint`/`nuint`, `float32`/`float64`, `bool`, `char`, `string` (governed by `CharSet`), single-element `*T` byref-style pointers (where `T` is primitive), and slices of primitives. Anything outside this set is rejected at bind time with `GS0323`.

### Diagnostics

`GS0322`–`GS0329` cover every malformed P/Invoke shape — missing library name, body present, unsupported marshalling type, unsupported function shape (async / generic / extension / `shared` / ref-returning), bad `CharSet` / `CallingConvention` / `EntryPoint` values, and `;` body without `@DllImport`. The historical `GS0211` blanket-rejection is retired. See the [Diagnostics reference](./diagnostics) for the full table.

## Unsupported interop surface

The following are not yet implemented as source features: the modern `@LibraryImport` source-generator form (deferred per ADR-0086 §4 to a follow-up), struct / class marshalling across the P/Invoke boundary, function-pointer marshalling, user-supplied custom marshallers, default parameter values in G# declarations, and C#-style `null` literals. Use `nil` for nullable values, import .NET APIs for library functionality, and wrap unsupported marshalling shapes behind a thin C# shim for now.
