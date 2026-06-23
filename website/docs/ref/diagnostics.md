---
title: "Diagnostics reference"
sidebar_position: 5
draft: false
---

# Diagnostics reference

This page mirrors the authoritative diagnostic catalogue in [`docs/diagnostics.md`](https://github.com/DavidObando/gsharp/blob/main/docs/diagnostics.md). Preserve these `GS####` meanings when configuring suppressions, warning promotion, or tooling.

Every diagnostic emitted by `gsc` carries a stable `GS####` identifier, a severity level, a human-readable message, and a source location (file, line, column). This document enumerates all identifiers so that project files can suppress or promote them using standard MSBuild properties.

## Severity levels

| Level | Meaning |
|-------|---------|
| **Error** | Compilation cannot succeed; `gsc` exits with code 1. |
| **Warning** | Compilation succeeds; `gsc` exits with code 0 unless `/warnaserror` is in effect. |
| **Info** | Informational; never affects the exit code. |

## Suppressing and promoting diagnostics

`gsc` accepts the following command-line flags (all also available via the `Gsharp.NET.Sdk` MSBuild SDK through the matching MSBuild properties):

| Flag | MSBuild property | Effect |
|------|-----------------|--------|
| `/nowarn:<ids>` | `<NoWarn>` | Suppress the listed warning IDs. Errors cannot be suppressed. |
| `/warnaserror` | `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` | Promote every warning to an error. |
| `/warnaserror+:<ids>` | `<WarningsAsErrors>` | Promote only the listed IDs to errors. |
| `/warnaserror-:<ids>` | — | Exempt the listed IDs from a global `/warnaserror`. |

IDs may be given as `GS0001`, `0001`, or the bare integer `1`; all three forms are equivalent.

**Example `.gsproj` snippet:**
```xml
<PropertyGroup>
  <!-- suppress a noisy warning -->
  <NoWarn>GS0168</NoWarn>
  <!-- treat a specific warning as an error -->
  <WarningsAsErrors>GS0176</WarningsAsErrors>
</PropertyGroup>
```

## Diagnostic catalogue

### Lexer diagnostics (GS0001–GS0005)

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0001 | Error | Bad character input. | Source contains a character that is not part of the GSharp alphabet (e.g. `` ` ``). |
| GS0002 | Error | Unterminated comment. | A `/*` that has no matching `*/`. |
| GS0003 | Error | Unterminated string literal. | A `"` that has no closing `"` before end-of-line or end-of-file. |
| GS0004 | Error | Invalid number literal. | `9999999999999999999` is out of range for `int`. |
| GS0005 | Error | Unexpected token. | Parser expected one token kind but found another (e.g. missing `)` or `;`). |

### Binder / semantic diagnostics (GS0100–GS0189)

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0100 | Error | Not all code paths return a value. | A non-void function is missing a `return` on some branch. |
| GS0101 | Error | Parameter already declared. | Two parameters share the same name. |
| GS0102 | Error | Symbol already declared. | A variable or function name is used twice in the same scope. |
| GS0103 | Error | Method receiver must be a struct or class declared in the same package. | Receiver type is a built-in or external type. |
| GS0104 | Error | `data struct` requires at least one field. | `data struct Foo {}` — use `struct` instead. |
| GS0105 | Error | `inline struct` requires exactly one field. | `inline struct Foo { a int; b int }` has two fields. |
| GS0106 | Error | `inline` cannot be combined with `data`. | `inline data struct Foo { … }` is not legal. (Historical: the `record` keyword was removed by ADR-0078; pre-removal this diagnostic also covered `inline record`.) |
| GS0107 | Error | `inline struct` cannot be combined with `open`. | `open inline struct Foo { … }` is not legal. |
| GS0108 | Error | Inline struct synthesised member conflicts with an explicit declaration. | An `inline struct` auto-generates certain member names that cannot be re-declared. |
| GS0109 | Error | (Historical) `record` was an alias for `data struct` and could not be combined with `data`. The `record` keyword was removed by ADR-0078; GS0307 replaces this on legacy sources. | `data record Foo { … }` — use `data struct Foo` or `data class Foo`. |
| GS0110 | Error | Empty enum declaration. | `enum Color {}` — an enum must have at least one member. |
| GS0111 | Error | Duplicate enum member. | Two members in the same `enum` share a name. |
| GS0112 | Error | Undefined enum member. | `Color.Purple` where `Purple` is not a declared member of `Color`. |
| GS0113 | Error | Undefined type. | A type name referenced in code does not exist. |
| GS0114 | Error | Invalid array length. | Array length must be a non-negative integer literal. |
| GS0115 | Error | Array literal length mismatch. | `[3]int{1, 2}` — literal has 2 elements but length is 3. |
| GS0116 | Error | Type is not indexable. | `x[0]` where `x` is `bool` or another type with no array/slice/map element access and no CLR indexer. Arrays, slices, maps, CLR indexers, and `Span[T]` / `ReadOnlySpan[T]` (ADR-0056 §2) are all indexable. |
| GS0117 | Error | Invalid argument type for a built-in function. | `len(42)` — `len` cannot be applied to an `int`. |
| GS0118 | Error | A `try` statement requires at least one `catch` or `finally` clause. | `try { f() }` with no `catch` or `finally`. |
| GS0119 | Error | Type is not disposable. | `using x = Foo()` where `Foo` provides no public `Dispose()` method. |
| GS0120 | Error | Invalid `break` or `continue`. | `break` used outside of a loop. |
| GS0121 | Error | Invalid `return`. | `return` used outside of a function. |
| GS0122 | Error | Void function cannot return an expression. | `return 42` inside a function declared without a return type. |
| GS0123 | Error | Missing return expression. | `return` with no value inside a function that returns `int`. |
| GS0124 | Error | Expression must have a value. | A void call used in a value position (e.g. `x = fmt.Println()`). |
| GS0125 | Error | Variable not defined. | `x` referenced before being declared. |
| GS0126 | Error | Name is not a variable. | `len = 5` — `len` is a function, not a variable. |
| GS0127 | Error | Variable is read-only. | Assignment to a `const` or `let`-bound name. |
| GS0128 | Error | Unary operator not defined for type. | `!42` — `!` is not defined for `int`. |
| GS0129 | Error | Binary operator not defined for types. | `true + 1` — `+` is not defined for `(bool, int)`. |
| GS0130 | Error | Undefined function. | A call to a function name that was never declared. |
| GS0131 | Error | Name is not a function. | `x()` where `x` is an `int` variable. |
| GS0132 | Error | `await` outside an `async func`. | `await someTask` in a regular (non-async) function. |
| GS0133 | Error | Expression is not awaitable. | `await 42` — `int` is not a `Task` or `Task[T]`. |
| GS0134 | Error | Expression is not async-enumerable. | `await for x in 42` — `int` does not implement `IAsyncEnumerable[T]`. |
| GS0135 | Error | `async` modifier in a type clause is only valid before `sequence[T]`, `(T) -> R`, or `func(...)`. | `async int` in a type position. |
| GS0136 | Error | `yield` outside an iterator function. | `yield return 1` in a function that returns `int`, not `sequence[int]`. |
| GS0137 | Error | `go` operand is not a call expression. | `go x + 1` — only function calls may follow `go`. |
| GS0138 | Error | `defer` operand is not a call expression. | `defer x + 1`. |
| GS0139 | Error | Receive operator `<-` requires a channel. | `<-42`. |
| GS0140 | Error | Send operator `<-` requires a channel on the left. | `42 <- x`. |
| GS0141 | Error | `close` requires a channel operand. | `close(42)`. |
| GS0142 | Error | `select` with no cases. | `select {}` is unreachable. |
| GS0143 | Error | `select` has more than one `default` arm. | Two `default:` arms inside one `select`. |
| GS0144 | Error | Wrong number of arguments to function. | `f(1, 2)` when `f` requires three arguments. |
| GS0145 | Error | Variadic parameter is not the last parameter. | `func f(a ...int, b string)`. |
| GS0146 | Error | Variadic parameter only allowed on top-level function declarations. | Variadic parameter on a closure or method. |
| GS0147 | Error | Too few arguments for variadic function. | Calling a variadic function with fewer than the minimum required arguments. |
| GS0148 | Error | Generic function has wrong number of type arguments. | `f[int, string]()` when `f` takes only one type parameter. |
| GS0149 | Error | Type is not generic. | `int[string]` — `int` accepts no type arguments. |
| GS0150 | Error | Type-parameter variance position violation. | A covariant type parameter used in a contravariant position. |
| GS0151 | Error | Type argument inference failed. | The compiler could not infer a type argument from the call arguments. |
| GS0152 | Error | Type argument does not satisfy constraint. | `f[MyStruct]()` where `MyStruct` does not implement the required interface constraint. |
| GS0153 | Error | Interface constraint is not sealed. | A generic constraint interface must be `sealed` (i.e. not `open`). |
| GS0154 | Error | Wrong argument type. | A positional argument's type does not match the parameter type. |
| GS0155 | Error | Cannot convert type. | An explicit cast between incompatible types. |
| GS0156 | Error | Cannot convert implicitly; explicit conversion exists. | `int x = 3.14` — an explicit cast is available but was not written. |
| GS0157 | Error | Cannot find type (possibly missing import). | A package-qualified type name that resolves to nothing. |
| GS0158 | Error | Cannot find member. | A field or property access that does not resolve. |
| GS0159 | Error | Cannot find function. | A package-qualified function name that resolves to nothing. |
| GS0160 | Error | Ambiguous overload. | A call that matches more than one overload equally well. Generic candidates are filtered against their `where`-constraints (ADR-0088); the constraint-disjoint case usually resolves to one candidate, but two candidates with mutually-incomparable constraint specificity remain ambiguous and report this code. |
| GS0161 | Error | `copy`/`with` receiver is not a `data struct`. | `.copy(…)` used on a plain `struct`. |
| GS0162 | Error | Named arguments only supported for `data struct` `.copy(…)`. | Named arguments passed to a regular function. |
| GS0163 | Error | Deconstruction field count mismatch. | `let (a, b) = p` where `p` is a `data struct` with three fields. |
| GS0164 | Error | Deconstruction requires a tuple or `data struct` initializer. | Deconstruction attempted on a plain `struct`. |
| GS0165 | Error | Multiple top-level files. | More than one source file contains top-level statements. |
| GS0166 | Error | Top-level statements conflict with an explicit `Main` function. | Both top-level statements and a `func Main()` are present. |
| GS0167 | Error | Multi-assignment target/value count mismatch. | `a, b = 1, 2, 3` — three values for two targets. |
| GS0168 | Error | `fallthrough` is not supported (ADR-0013). | `fallthrough` keyword used in a `switch` case body. |
| GS0169 | Error | Duplicate `default` arm in `switch`. | Two `default:` arms inside one `switch` statement. |
| GS0170 | Error | Switch case value is not a constant expression. | `case x:` where `x` is a mutable variable. |
| GS0171 | Error | Switch case type is incompatible with the switch expression. | `switch (s) { case 42: }` where `s` is `string`. |
| GS0172 | Error | Property pattern requires a struct or class value. | A property pattern `{ Field: value }` applied to a non-struct/class type. |
| GS0173 | Error | Undefined field on type. | Accessing a struct field that was never declared. |
| GS0174 | Error | Relational pattern operator not defined for type. | `case > 5:` where the switched type doesn't support `>`. |
| GS0175 | Error | List pattern requires an array or slice. | List pattern `[a, b]` applied to a non-array/slice value. |
| GS0176 | Error | Switch expression is missing a `default` arm. | A `switch` expression that cannot be proven exhaustive and has no `default`. |
| GS0177 | Error | Switch expression on enum is not exhaustive. | One or more enum members not covered and no `default` arm. |
| GS0178 | Error | Switch statement on enum is not exhaustive. | One or more enum members not covered and no `default` arm. |
| GS0179 | Error | Switch expression arm type mismatch. | Different arms of a `switch` expression produce incompatible types. |
| GS0180 | Error | Accessibility modifier not allowed here. | `pub` or `priv` used on a local variable or inside a function body. |
| GS0181 | Error | Base class is not open. | Inheriting from a class that was not declared `open`. |
| GS0182 | Error | Method is overridable; `override` required. | Redefining an `open` method without the `override` keyword. |
| GS0183 | Error | No matching open base method for `override`. | `override` keyword present but no base class defines a matching open method. |
| GS0184 | Error | Cannot override a non-open base method. | `override` targets a method that was not declared `open`. |
| GS0185 | Error | Override signature mismatch. | An `override` method has different parameter types or return type than the base. |
| GS0186 | Error | _(historical — removed in ADR-0085)_ Interface method may not have a body. | Default-interface methods are now supported (see GS0318–GS0321). |
| GS0187 | Error | Class does not implement interface method. | A class claims to implement an interface but a required method is absent. |
| GS0188 | Error | Class cannot implement a sealed interface from a different package. | Implementing a `sealed interface` defined outside the current package. |
| GS0189 | Error | The return type of an `async func(...)` type clause is implicitly wrapped in `Task`; do not write `Task[…]` explicitly. | `async func(int) Task[int]` in a type position (ADR-0043). |

### Async state-machine diagnostics (GS0190)

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0190 | Error | Async state machine unavailable for this function. | An `async func` uses a language feature that the GSharp async emitter does not yet support (e.g. `await` inside a nested `try` block). |

### Character literal diagnostics (GS0191–GS0195)

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0191 | Error | Unterminated character literal. | A `'` that has no closing `'` before end-of-line. |
| GS0192 | Error | Empty character literal; a character literal must contain exactly one code unit or escape. | `''` with nothing inside. |
| GS0193 | Error | Character literal contains more than one code unit; use a string literal instead. | `'ab'`. |
| GS0194 | Error | Unrecognised escape sequence in character literal. | `'\q'`. |
| GS0195 | Error | Malformed Unicode escape in character literal. | `'\u00G0'`. |

### Attribute / annotation diagnostics (GS0196–GS0211)

ADR-0047 introduces Kotlin-style attribute syntax (`@Foo(...)`) and the `@Attribute` declaration sugar. The following diagnostics cover parsing, resolution, use-site validation, and the compiler-recognised attribute set.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0196 | Error | Annotation name expected after `@`. | `@ func Foo() {}` — bare `@` with no identifier. |
| GS0197 | Error | Annotation target is not a recognized use-site kind. | `@bogus:Foo func Bar() {}` — must be one of `field`, `param`, `return`, `type`, `method`, `property`, `event`, `module`, `assembly`, `genericparam`. |
| GS0198 | Error | Attribute type could not be found. | `@DoesNotExist func Foo() {}` — neither `DoesNotExist` nor `DoesNotExistAttribute` resolves to a type. |
| GS0199 | Error | Attribute name is ambiguous between `Foo` and `FooAttribute`. | Both types are in scope; qualify to disambiguate. |
| GS0200 | Error | Type is not an attribute class (it does not derive from `System.Attribute`). | `@int func Foo() {}`. |
| GS0201 | Error | Attribute target is not valid at this position. | `@field:Obsolete func Foo() {}` — `field` is not allowed on a function. |
| GS0202 | Error | Attribute arguments must be compile-time constants. | `@Trace(myVar)` — argument is not a primitive, string, `typeof`, enum, or 1-D array thereof. |
| GS0203 | Error | Class tagged `@Attribute` cannot also declare an explicit base class. | `@Attribute class Trace : Other {}` — the `@Attribute` sugar implies `: System.Attribute`. |
| GS0204 | **Warning** (Error if `IsError=true`) | Reference to a symbol marked `[Obsolete]`. | Calling a function, instantiating a class (`Old(5)`), writing a struct literal (`Old{}`), naming a struct/class/interface/enum in a type clause, reading an obsolete parameter, reading/writing an obsolete `var`/`let`/`const`, reading an obsolete enum member (`Color.Red`), or reading/writing an obsolete struct/class field (`p.Old`) — all declared with `@Obsolete("use Bar")`. Severity is promoted to error when the attribute's second argument is `true`. |
| GS0205 | Error | Attribute is reserved for compiler synthesis. | `@CompilerGenerated`, `@Extension`, `@AsyncStateMachine`, `@Nullable`, or `@NullableContext` written in user source. |
| GS0206 | Error | Annotations are only allowed on variable declarations, not on this statement. | `@Obsolete\nreturn` inside a function body — annotations may precede `var`/`let`/`const` but no other statement kind. |
| GS0207 | Error | Parameter `{name}` is annotated `@EnumeratorCancellation` but has type `{type}`; only `System.Threading.CancellationToken` parameters can carry this annotation. | `@EnumeratorCancellation` placed on a `string` parameter. |
| GS0208 | Error | Parameter `{name}` is annotated `@EnumeratorCancellation` but its enclosing function is not an async sequence (does not return `IAsyncEnumerable[T]`). | `@EnumeratorCancellation` on a sync function or a non-sequence async function. |
| GS0209 | Error | Attribute `{name}` is not valid on this position; its `[AttributeUsage]` permits only: `{targets}`. | Applying a `@field`-targeted attribute to a method. |
| GS0210 | Error | Duplicate attribute `{name}`; this attribute type does not allow multiple applications (`AllowMultiple = false`). | Two `@Trace(...)` annotations on the same declaration. |
| GS0211 | Error | _(repurposed in ADR-0086)_ Attribute `[DllImport]` was historically rejected wholesale; well-formed `@DllImport`-annotated P/Invoke declarations are now accepted (see GS0322–GS0329 for shape-specific diagnostics). The slot is reserved for any future blanket-rejection use. | n/a — no longer fired. |
| GS0212 | Error | Function `{name}` is marked `@Conditional` but does not return `void`; conditional methods must return `void` because calls may be elided at the call site. | `@Conditional("DEBUG") func Probe() int32 { return 0 }`. |

### Class / constructor diagnostics (GS0213–GS0217)

Issue #306 covers user class constructor flow — explicit `init(...)` constructors, primary constructors, and `base(...)` initializers.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0213 | Error | A base-constructor argument list requires an explicit base class. | `init() : base(1) { }` written on a class with no `: BaseType` clause. |
| GS0214 | Error | Class `{base}` has no accessible constructor that takes `{N}` argument(s). | `init() : base(1, 2)` when the base only declares `init()`. |
| GS0215 | Error | Class `{name}` cannot declare both a primary constructor and an explicit `init` constructor. | `class Customer(id int32) { init(name string) { } }`. |
| GS0216 | Error | Class `{name}` declares multiple `init` constructors; only a single explicit constructor is supported. | Two `init(...)` declarations in the same class body. |
| GS0217 | Error | Generic class `{name}` with an explicit `init` constructor cannot be constructed; generic explicit constructors are not supported. | `class Box[T] { init(x T) { } }` then `Box[int32](42)`. |

### Delegate conversion diagnostics (GS0218)

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0218 | Error | Cannot convert method group `{name}` to `{type}`. No overload matches the target delegate signature. | `var a Action = SomeOverloaded` where no overload of `SomeOverloaded` has signature `() -> void`. |

### String interpolation diagnostics (GS0220–GS0225)

ADR-0055 interpolation holes (`${expr,alignment:format}`) and the issue #368 interpolated-string-handler pattern report the following.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0220 | Error | Interpolation alignment clause is not a constant integer. | `"${x,abc}"` — the value after the `,` in `${expr,alignment[:format]}` must be a constant integer (e.g. `${x,5}` or `${x,-8:X4}`). |
| GS0221 | Error | An interpolated string passed to an `[InterpolatedStringHandler]` parameter could not satisfy `[InterpolatedStringHandlerArgument]` forwarding. | The forwarded argument names an unknown parameter, the receiver cannot be forwarded, or no handler constructor matches `(int, int, …forwarded[, out bool])`. |
| GS0222 | Error | Unterminated interpolation hole; expected a closing `}`. | `"v=${a + b"` — the `${` opens a hole that the delimiter-aware scanner never closes before end of file. |
| GS0223 | Error | Empty interpolation hole; expected an expression between `${` and `}`. | `"x=${}"` — a hole must contain an expression. |
| GS0224 | Error | Empty format specifier; expected a format string after `:`. | `"${n:}"` — a `:` clause must be followed by a non-empty format string. |
| GS0225 | Error | Newline in the literal portion of an interpolated string; only `${ … }` holes may span lines. | A raw newline appears outside a hole, e.g. a `"…` opened on one line with no closing `"` before the line break. (Multiline holes themselves are legal.) |

> Note: ADR-0055 originally proposed GS0212–GS0216 for the malformed-hole diagnostics, but those codes were already taken; the implemented codes are **GS0222–GS0225**.

### By-ref-like (`ref struct`) diagnostics (GS0219)

A by-ref-like type — a CLR `ref struct` carrying `System.Runtime.CompilerServices.IsByRefLikeAttribute`, such as `System.Span[T]`, `System.ReadOnlySpan[T]`, or `System.Runtime.CompilerServices.DefaultInterpolatedStringHandler` — is stack-only (issue #367). G# permits declaring and using such a value as an ordinary local, but the CLR forbids any use that would let it reach the heap. Those escapes are rejected with GS0219.

G# can also **declare** its own by-ref-like value types with a `ref` modifier on a `struct` declaration:

```gsharp
ref struct Window {
    Items ReadOnlySpan[int32]   // a ref struct may hold by-ref-like fields
    Label string
}
```

Such a type is emitted with `System.Runtime.CompilerServices.IsByRefLikeAttribute` (and the C# compiler's `[Obsolete]` guard marker), so the CLR treats it as stack-only. The same escape rules below apply to user-declared `ref struct` types exactly as they do to imported ones. The only relaxation is that a `ref struct` may itself hold by-ref-like fields (it is stack-only too); a static field of a `ref struct` is still rejected.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0219 | Error | A by-ref-like (`ref struct`) value is used in a position that would let it escape the stack: boxing / converting it to a reference type (`object`, an interface, a delegate base), storing it in a field of a non-ref-struct (instance, primary-constructor, or static), capturing it in a closure, declaring it as a local in an `async` function or an iterator (where it would be hoisted into the heap-allocated state machine), using it as a generic type argument, or returning it from a function when the parameter is annotated `scoped`. | `var o object = span` (box); a `class`/`struct` field typed `Span[int32]`; capturing a `ReadOnlySpan[char]` local inside `func() { ... }`; declaring a `Span[int32]` local in an `async` function; `List[ReadOnlySpan[int32]]`; `func f(scoped s Span[int32]) Span[int32] { return s }`. |

The `scoped` modifier can be placed on a parameter to indicate that the `ref struct` (or managed-pointer) value must not be returned or stored beyond the call site:

```gsharp
import System
// `scoped` means `s` cannot be returned or escape.
func firstElement(scoped s ReadOnlySpan[int32]) int32 {
    return s[0]
}
```

### Span element access diagnostics (GS0226)

ADR-0056 §1/§2 makes spans indexable: a `Span[T]` / `ReadOnlySpan[T]` indexer returns a managed pointer (`ref T` / `ref readonly T`), and a read in rvalue position auto-dereferences to the pointee `T` (§1). A `Span[T]` element write `span[i] = v` stores through the `ref T`. A `ReadOnlySpan[T]` element is `ref readonly T`, so writing through it is a hard error (GS0226); reading it is always permitted.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0226 | Error | Cannot assign through a read-only span element (`ReadOnlySpan[T]` is read-only). | `var s ReadOnlySpan[int32] = arr` then `s[0] = 1` — a `ReadOnlySpan[T]` indexer is `ref readonly T`; use `Span[T]` to write. |

### Pointer / by-ref diagnostics (GS9001–GS9006)

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS9001 | Error | Cannot take the address of a non-lvalue. | `&(1 + 2)` — the operand is a temporary expression. |
| GS9002 | Error | Argument must be passed by `ref`. | A `ref` parameter called without the `ref` modifier. |
| GS9003 | Error | Variable not definitely assigned before `ref` use. | `ref x` where `x` has not been assigned. |
| GS9004 | Error | By-ref value cannot escape its declaration scope. | Returning a `*T` (managed-pointer) value from a function, capturing a `*T` local in a closure, hoisting a `*T` local into an `async`/iterator state machine, or using a `*T` return type in a function literal. Also raised when returning a `ref struct` parameter annotated as `scoped`. |
| GS9005 | Error | Cannot take the address of a constant. | `&myConst` where `myConst` is declared `const`. |
| GS9006 | Error | Pointer type cannot be a field type. | A struct or class field (including static `shared` fields and top-level globals) declared with a `*T` (managed-pointer) type. |
| GS9007 | Error | A type may contain at most one `shared` block. | A class or struct with two `shared { ... }` blocks; merge them into one. |

### Reference closure diagnostics (GS9100)

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS9100 | **Warning** | One or more assemblies supplied via `/r:` depend (transitively) on assemblies that were not also supplied, so the reference set is not a complete transitive closure. The compiler degrades gracefully — members whose signatures live in the missing assemblies are skipped rather than aborting the build — but the affected members become invisible. The message names the missing assemblies. Add the missing package/project reference (the SDK passes `@(ReferencePathWithRefAssemblies)`, MSBuild's full transitive closure, so this normally only appears with a hand-rolled `/r:` set). Suppress with `/nowarn:GS9100`. | `gsc /r:LibAsmA.dll app.gs` where `LibAsmA.dll` references `DepAsmB.dll` and `DepAsmB.dll` is not also passed. |

### Internal / emit diagnostics (GS9998–GS9999)

These diagnostics indicate an internal compiler problem. If you encounter them, please file an issue.

| ID | Severity | Description |
|----|----------|-------------|
| GS9998 | Error | An unexpected `NotSupportedException` or `InvalidOperationException` was raised during IL emission. The message text contains the original exception message. |
| GS9999 | Error | An unexpected exception was caught by the evaluator. The message text contains the original exception message. |

## Documentation diagnostics (GS0227–GS0231)

| Code | Severity | Message |
|------|----------|---------|
| GS0227 | Warning | Documentation comment is not attached to a declaration. |
| GS0228 | Warning | Missing documentation comment on public member `{name}`. (opt-in) |
| GS0229 | Warning | Documentation @param `{name}` does not match any parameter of `{symbol}`. |
| GS0230 | Warning | Unsupported documentation Markdown: `{detail}`. |
| GS0231 | Warning | Unknown documentation tag `{tag}`. Valid tags are: @param, @typeparam, @returns, @remarks, @value, @exception, @seealso. |

## Data struct diagnostics (GS0232)

ADR-0029 / Issue #410: every `data struct` synthesizes a fixed contract of value-semantics members — `Equals(object)`, `Equals(Name)`, `GetHashCode()`, `ToString()`, `op_Equality(Name, Name)`, `op_Inequality(Name, Name)`, and `Deconstruct(out T1, out T2, …)`. Hand-written versions are rejected so the contract stays predictable and so consumers (G# and external .NET) can rely on the synthesized IL.

| Code | Severity | Message |
|------|----------|---------|
| GS0232 | Error | Data struct `{type}` synthesizes member `{member}`; it cannot be declared explicitly. |

## Named delegate type diagnostics (GS0233–GS0234)

ADR-0059 / Issue #255: `type Name = delegate func(...)` declares a real CLR `MulticastDelegate`-derived named delegate type so C# consumers see a conventional handler type (and so G# events can carry first-class custom delegate types). Anything other than a function signature on the right-hand side is rejected, and generic delegate types are reserved for v2.

| Code | Severity | Message |
|------|----------|---------|
| GS0233 | Error | Named delegate declaration requires 'func(...)' after 'delegate' (e.g. 'type Name = delegate func(sender Object, e EventArgs)'). |
| GS0234 | Error | Generic delegate declaration `{name}` is not yet supported; declare a non-generic named delegate type (ADR-0059 follow-up). |

## Ref-kind parameter diagnostics (GS0235–GS0243)

ADR-0060 introduces explicit `ref`, `out`, and `in` parameter passing modes at both call sites and method-definition sites. The ADR (§8) originally enumerated diagnostics GS0230–GS0238, but those codes were already in use by ADR-0029 / ADR-0030 / ADR-0056 / ADR-0059; the ADR-0060 diagnostics ship at the next free range, GS0235–GS0243, with a 1:1 mapping (GS0230→GS0235, GS0231→GS0236, …, GS0238→GS0243). The async/iterator ban (§10) reuses the existing GS0226 family.

| Code | Severity | Message |
|------|----------|---------|
| GS0235 | Error | Argument `{index}` (parameter `{name}`) passes with ref-kind `{actual}` but the parameter is declared `{expected}`. |
| GS0236 | Error | An 'out var/let/_' inline declaration is only valid on an 'out' argument. |
| GS0237 | Error | Cannot assign to 'in' parameter `{name}` — it is read-only. |
| GS0238 | Error | The 'out' parameter `{name}` must be assigned on every path before the function returns. |
| GS0239 | Error | The variable `{name}` must be definitely assigned before it can be passed by 'ref'. |
| GS0240 | Error | Override of `{name}` must match the base ref-kind on parameter `{parameter}` (`{baseKind}` vs `{overrideKind}`). |
| GS0241 | Error | A variadic parameter cannot carry a ref-kind modifier ('ref'/'out'/'in'). |
| GS0242 | Warning | Argument `{index}` (parameter `{name}`) is passed by 'in' implicitly; add 'in' at the call site to make the read-only pass explicit. |
| GS0243 | Error | A pointer type '*T' is not a valid parameter type; use the appropriate ref-kind modifier instead (e.g. 'ref T', 'out T', 'in T'). |

Cause/fix examples:

- **GS0235** — fire when the call-site modifier doesn't match the declaration: `f(x)` where `f(ref x int32)` requires `f(&x)` or `f(ref x)`. Fix: add the matching modifier; if the parameter is by-value, drop any unwanted `ref`/`out`/`in`.
- **GS0236** — `out var n` outside an `out` argument: e.g. `func g(int32) {}` then `g(out var n)`. Fix: only use the inline declaration when the parameter is declared `out`.
- **GS0237** — assignment to an `in` parameter inside the body: `func h(in p int32) { p = 0 }`. Fix: copy to a local for any mutation, or change the parameter to `ref`.
- **GS0238** — a missing write before return on an `out` parameter: `func k(out r int32) bool { if cond { r = 1; return true } return false }` — the `false` branch fails to assign `r`. Fix: assign on every path.
- **GS0239** — passing an uninitialized variable by `ref`: `var x int32; f(ref x)` with no prior assignment. Fix: assign before the call (e.g. `var x = 0`).
- **GS0240** — override changes the ref-kind of an inherited parameter: `func override f(in p int32) { … }` when the base declares `f(ref p int32)`. Fix: match the base declaration.
- **GS0241** — variadic combined with ref-kind: `func g(ref values ...int32) {}`. Fix: remove the modifier or remove the variadic decoration.
- **GS0242** (warning) — passing a plain identifier to an `in` parameter without writing `in`: `f(x)` where `f(in x int32)`. Fix: write `f(in x)` to make the pass-by-readonly-ref explicit. The compiler does NOT silently spill the value (a deliberate departure from C#).
- **GS0243** — declaring a parameter whose type is the raw pointer `*T`: `func f(p *int32)`. Fix: use a ref-kind modifier instead — `func f(ref p int32)` (or `in`/`out`).

## Named-argument diagnostics (GS0244–GS0247)

Issue #343 introduces named arguments at call sites — `Foo(timeout: 30, retries: 3)` — for free functions, user methods, user constructors, user extension functions, imported CLR methods and constructors, imported extension methods, and inherited CLR instance methods (including delegate `Invoke`). Indirect calls through a function-typed or delegate-typed variable, and variadic call sites, intentionally do not accept named arguments because the call target does not preserve parameter names. The diagnostics below flag malformed or unresolvable named-argument call sites.

| Code | Severity | Message |
|------|----------|---------|
| GS0244 | Error | Positional argument cannot follow a named argument. |
| GS0245 | Error | Named argument `{name}` is specified more than once. |
| GS0246 | Error | The best overload of `{callee}` does not have a parameter named `{name}`. |
| GS0247 | Error | Named argument `{name}` specifies a parameter for which a positional argument has already been given. |

Cause/fix examples:

- **GS0244** — `Foo(1, name: "a", 2)`. Fix: move every named argument to the trailing positions, or pass the named one positionally.
- **GS0245** — `Foo(timeout: 1, timeout: 2)`. Fix: remove the duplicate.
- **GS0246** — `Foo(qty: 3)` when `Foo` has no parameter named `qty`. Fix: use the correct parameter name. Also fires when calling through a function-typed/delegate variable, or when targeting a variadic parameter list (parameter names are not addressable in those cases).
- **GS0247** — `Foo(1, x: 2)` when `Foo(x int32, y int32)` is bound — the positional `1` already filled `x`. Fix: drop one or the other.

## Ref-aliasing local diagnostics (GS0256–GS0258)

Issue #491 (ADR-0060 follow-up) introduces `let ref` / `var ref` aliasing locals — a local whose IL slot is a managed pointer `T&` and that aliases another lvalue (`let ref m = arr[i]`, `var ref v = c.Field`). The diagnostics below flag malformed or illegal ref-alias declarations.

| Code | Severity | Message |
|------|----------|---------|
| GS0256 | Error | The right-hand side of a 'ref' local declaration must be an lvalue (variable, field, indexer, or dereference). |
| GS0257 | Error | A 'ref' local cannot be initialized from an expression with a narrower escape scope than the local itself. |
| GS0258 | Error | A 'ref' local cannot be declared here — only inside non-async, non-iterator function bodies (no top-level, no `const`). |

Cause/fix examples:

- **GS0256** — `let ref m = 1 + 2` or `let ref m = foo()`. The RHS must denote storage you can take the address of. Fix: alias an addressable expression (`let ref m = arr[0]`, `let ref m = c.Value`, `let ref m = *p`), or drop `ref` and copy the value.
- **GS0257** — Reserved for the full ref-safety analysis. Will fire when the RHS storage cannot live as long as the alias (e.g. a `ref` returned from a callee that captured a shorter-lived local). V1 has no ref returns, so this code is defined for forward compatibility and currently does not fire.
- **GS0258** — `let ref m = n` at top level, inside `async func`, inside an iterator (yield-returning) function, or written as `const ref`. Fix: move the declaration into a synchronous, non-iterator function body and use `let ref` / `var ref` (not `const ref`). Top-level `ref` locals would require a static field of `T&`, which the CLR forbids; async / iterator bodies would lift the slot onto a state-machine field, which the CLR likewise forbids.


## Conditional expression diagnostics (GS0259–GS0263)

ADR-0061 introduced a narrow ref-only ternary form (`cond ? a : b` only inside `ref`/`out`/`in` argument payloads and `&` operands) with diagnostics GS0259–GS0262. ADR-0062 generalises the ternary into a normal expression form. The conditional-outside-ref diagnostic GS0259 is therefore retired: a value-context `cond ? a : b` is now legal. The remaining ADR-0061 diagnostics still fire in their byref contexts; the new GS0263 covers the value-context "no common type" failure.

| Code | Severity | Message |
|------|----------|---------|
| GS0259 | Error (retired by ADR-0062) | Conditional lvalue expression (`cond ? a : b`) is only legal as the payload of a 'ref'/'out'/'in' argument modifier or as the operand of '&'. Now only fires for the legacy inner-ref-modifier shape outside ref context. |
| GS0260 | Error | Both branches of a conditional ref-argument must produce lvalues of the same type, but the true branch is `{trueType}` and the false branch is `{falseType}`. |
| GS0261 | Error | An 'out var'/'out let'/'out _' inline declaration cannot appear inside a branch of a conditional ref-argument (the new local would only conditionally exist). Declare the local before the call instead. |
| GS0262 | Error | Inner ref-kind modifier `{innerModifier}` on a conditional ref-argument branch must match the outer modifier `{outerModifier}`. |
| GS0263 | Error | Conditional expression branches have no common result type — the true branch is `{trueType}` and the false branch is `{falseType}`. Add an explicit conversion to align the two arms. |

Cause/fix examples:

- **GS0260** — `bump(ref true ? a32 : b64)` where `a32 int32` and `b64 int64`. Fix: align the branch types (e.g. introduce a local of the wider type or use a value ternary outside the `ref`).
- **GS0261** — `produce(out true ? a : out var n)` — the inline `out var n` would declare a local that only exists on one branch. Fix: declare `var n int32` before the call.
- **GS0262** — `bump(ref true ? in a : ref b)` — the inner `in` does not match the outer `ref`. Fix: use `bump(ref true ? a : b)` (the generalized ADR-0062 form requires no inner modifiers).
- **GS0263** — `var x = pick ? true : "no"` — `bool` and `string` have no common type. Fix: explicitly convert one arm (e.g. `pick ? "yes" : "no"`).

## Ref-return diagnostics (GS0248–GS0255)

Issue #490 (ADR-0060 follow-up) introduces `ref`-returning functions — declarations of the form `func f(...) ref T { ... }` that return a managed pointer `T&` rather than a copied value, paired with the `return ref <expr>` statement form. The diagnostics below guard the declaration and return-site rules.

| Code | Severity | Message |
|------|----------|---------|
| GS0248 | Error | A 'ref' return modifier requires an explicit return type clause (e.g. 'ref int32'). |
| GS0249 | Error | 'ref' return is not legal on an `{async/iterator}` function; the state-machine rewriter cannot hoist a managed pointer. |
| GS0250 | Error | 'ref' return modifier is redundant when the declared return type is already a managed pointer ('*T'); write 'ref T' instead. |
| GS0251 | Error | 'return ref' is not allowed in `{functionName}` because its declaration does not specify a 'ref' return type. |
| GS0252 | Error | Function `{functionName}` returns by reference; use `return ref <expr>` instead of a plain 'return'. |
| GS0253 | Error | The operand of 'return ref' must be an lvalue (variable, field, array element, or '*p'). |
| GS0254 | Error | Cannot return a managed pointer to function-local storage; the reference would dangle once the function returns. |
| GS0255 | Error | Override of `{memberName}` must match the base return ref-kind: base returns `{expected}`, this declaration returns `{actual}`. |

Cause/fix examples:

- **GS0248** — `func f(x int32) ref { return ref x }` — `ref` requires the element type. Fix: `func f(x int32) ref int32`.
- **GS0249** — `async func f() ref int32 { ... }` or a yield-iterator body. Fix: drop `ref` from the return — `async` / iterator state-machine fields cannot hold managed pointers.
- **GS0250** — `func f(p *int32) ref *int32 { return p }`. Fix: write `ref int32` (or drop `ref` and return the pointer).
- **GS0251** — a `return ref x` statement in a function whose declaration is `func f() int32`. Fix: add `ref` to the return type, or drop `ref` from the return statement.
- **GS0252** — a plain `return x` in a `ref`-returning function. Fix: write `return ref x`.
- **GS0253** — `return ref (a + b)` or `return ref Foo()`. Fix: alias an addressable expression first (`let ref t = arr[i]; return ref t`) or restructure to return a pointer to durable storage.
- **GS0254** — `func f() ref int32 { var x = 0; return ref x }`. Fix: do not return references to function locals; consume the value by copy or alias storage that outlives the call.
- **GS0255** — overriding a base method declared `int32` with a `ref int32` override (or vice versa). Fix: match the base return ref-kind exactly.

## Method-overloading and optional-parameter diagnostics (GS0264–GS0267)

ADR-0063 lifts the v0 "one declaration per name" rule, so G# user functions can carry overload sets (differing by parameter types or ref-kinds) and optional parameters with default values. The diagnostics below cover overload-set construction and overload resolution.

| Code | Severity | Message |
|------|----------|---------|
| GS0264 | Error | An overload of `{name}` with signature `{signature}` is already declared. Two overloads must differ by parameter types or ref-kinds. |
| GS0265 | Error | Optional parameter `{parameterName}` is invalid: `{reason}`. |
| GS0266 | Error | Call to `{name}` is ambiguous between multiple overloads. Disambiguate with explicit types or named arguments. |
| GS0267 | Error | No overload of `{name}` is applicable to the given argument list. |

Cause/fix examples:

- **GS0264** — two `func F(x int32) {}` declarations, or two declarations that differ only in return type. Fix: change the parameter list (different types, arity, or ref-kinds); return type alone is not a distinguishing signature.
- **GS0265** — a default-value expression that is not constant, a parameter whose default depends on another parameter, an optional parameter preceding a required one without all trailing parameters also optional, or an optional ref/out parameter. Fix: use a compile-time-constant default, place optional parameters at the end of the list, and avoid combining `ref`/`out` with defaults.
- **GS0266** — `Greet("ada")` when both `Greet(string)` and `Greet(name string)` are visible via different paths. Fix: rename one, change one signature, or use a named argument that only one overload accepts.
- **GS0267** — `Greet(42)` when only `Greet(string)` is declared. Fix: pass a value of the expected type, or add an overload covering the new argument shape.

## `if let` and `guard let` binding diagnostics (GS0296–GS0297)

ADR-0071 introduces the `if let` and `guard let` binding forms. The diagnostics below cover the two misuse paths that the binder rejects up front.

| Code | Severity | Message |
|------|----------|---------|
| GS0296 | Error | The right-hand side of an `if let` / `guard let` binding must be of nullable type; non-nullable initializers have nothing to strip. |
| GS0297 | Error | The else block of `guard let` must unconditionally exit the enclosing scope (`return`, `throw`, `break`, or `continue`). |

Cause/fix examples:

- **GS0296** — `let s = "hi"; if let v = s { ... }`. Fix: either use a plain `let v = s` (no narrowing) or pass a nullable value. The binding only makes sense when the RHS has type `T?`.
- **GS0297** — `guard let v = s else { var x = 1 }`. Fix: make the else block exit the enclosing scope — `return`, `throw`, `break`, or `continue`. The binding is only in scope after the guard precisely because the else cannot fall through.

## Top-level-statement diagnostics (GS0285–GS0287)

ADR-0066 (top-level statements). The three diagnostics below cover
the project-shape / placement / return-shape rules that the synthesized
entry point depends on.

| Code | Severity | Message |
|------|----------|---------|
| GS0285 | Error | Top-level statements are not allowed in a library project. Set `<OutputType>Exe</OutputType>` on the project, or move the statements into an explicit `func Main()`. |
| GS0286 | Warning | Top-level statements should form a single contiguous block within a file — interleaving them with type or function declarations is hard to read. |
| GS0287 | Error | Top-level statements mix bare `return;` and `return <expr>;`. Choose one return shape so the synthesized entry point has a single return type. |

## Field declaration `var` / `let` requirement (GS0288)

ADR-0067. Field declarations inside a `struct`, `class`, or `shared`
block must carry a leading `var` (mutable) or `let` (read-only)
keyword. The keyword distinguishes mutable from read-only storage and
keeps type bodies visually consistent with property, event, and method
members.

| Code | Severity | Message |
|------|----------|---------|
| GS0288 | Error | Field declarations require a `var` (mutable), `let` (read-only), or `const` (compile-time constant) keyword. |

Cause/fix — `struct Point { x int32; y int32 }` → `struct Point { var x int32; var y int32 }` (or `let` for read-only, `const` for a compile-time constant). The parser recovers by treating the field as `var`, but the error still fires.

## Inline field initializer diagnostics (GS0375–GS0377)

Issue #948 — `const`/`let`/`var` fields in a type body may carry an inline
`= expr` initializer. Instance initializers run before each constructor body in
declaration order; `const` fields fold to compile-time literal fields; static
(`shared`) initializers run in the static constructor.

| Code | Severity | Message |
|------|----------|---------|
| GS0375 | Error | A `const` field requires an initializer. |
| GS0376 | Error | A `const` field initializer must be a compile-time constant expression. |
| GS0377 | Error | A field initializer cannot reference the instance member or constructor parameter `{name}` (field initializers run before the constructor body, so `this` is not available). Assign it in an `init(...)` constructor instead. |


## `protected` accessibility diagnostics (GS0379–GS0380)

Issue #950 — the `protected` access modifier (CIL `family`) makes a member
accessible within its declaring type and the bodies of derived types only.
Because protection is only meaningful where a derived type can exist,
`protected` is restricted to members of an inheritable `open class`.

| Code | Severity | Message |
|------|----------|---------|
| GS0379 | Error | `'{Type}.{member}' is inaccessible due to its protection level: a 'protected' member is only accessible within '{Type}' and types derived from it.` |
| GS0380 | Error | `'protected' is only allowed on members of an 'open class' (a type that can be inherited). Mark the enclosing class 'open', or use a different accessibility.` |


## `deinit` (finalizer) diagnostics (GS0289–GS0292)

ADR-0068 / issue #698 — `deinit { … }` declares a CLR finalizer on a
class. The diagnostics below cover the placement and shape rules.

| Code | Severity | Message |
|------|----------|---------|
| GS0289 | Error | `deinit` is only valid on a class type — `<type>` is a `<kind>`. |
| GS0290 | Error | Class `<name>` declares more than one `deinit`; only the first declaration emits a finalizer. |
| GS0291 | Error | `deinit` may not declare parameters — the CLR invokes the destructor with no arguments. |
| GS0292 | Error | `deinit` may not declare a return type — the CLR finalizer always returns void. |

## Labeled `break` / `continue` diagnostics (GS0293–GS0295)

ADR-0070 / issue #707 — labeled loops and `break label` / `continue
label` targeting an enclosing loop by name.

| Code | Severity | Message |
|------|----------|---------|
| GS0293 | Error | No enclosing loop is labeled `<label>` (in `break <label>` / `continue <label>`). |
| GS0294 | Error | Label `<label>` can only be applied to a loop statement (`for` / `while` / `do-while`). |
| GS0295 | Warning | Label `<label>` shadows an enclosing loop label of the same name; the inner label wins for nested `break` / `continue`. |

Cause/fix:

- **GS0293** — typo or stale name; spell the label exactly as it appears on the enclosing loop.
- **GS0294** — label-prefixes only attach to the three loop forms; remove the prefix on `if`/`switch`/etc.
- **GS0295** — rename the inner label so the two are distinguishable, or accept the inner-wins semantics.

## If-expression diagnostics (GS0276–GS0277)

ADR-0064 generalises `if` so that it can sit in value position (`let x = if cond { a } else { b }`). The diagnostics below guard the two binder rejection paths that are unique to the expression form; the branch-type-mismatch case reuses GS0263 (shared with the ADR-0062 ternary).

| Code | Severity | Message |
|------|----------|---------|
| GS0276 | Error | An if-expression in value position must have an `else` branch so that all code paths produce a value. |
| GS0277 | Error | A block in an if-expression value position must end with a value-producing expression. |

Cause/fix examples:

- **GS0276** — `let x = if cond { 1 }` — the if has no `else`, so when `cond` is false there is no value to bind. Add a terminal `else { … }`, or use the statement form (`if cond { x = 1 }`). The same rule applies to chained `else if` shapes: every chain must end in a terminal `else`.
- **GS0277** — `let x = if cond { } else { 1 }` — the then-block is empty. Replace the empty block with `{ <expr> }`, or fall through with an explicit value (`{ 0 }`). Also fires when the block's last statement is a non-expression form (`for`, `while`, etc.) and there is no trailing expression to lift out.
- **GS0263** also covers if-expression branches with no common result type (e.g. `if cond { true } else { "no" }`). Mirrors the ternary diagnostic since both forms share `ComputeConditionalCommonType`.

## Null-coalescing compound assignment diagnostics (GS0298–GS0299)

ADR-0072 introduces the `??=` null-coalescing compound assignment statement. The diagnostics below cover the two shapes the binder rejects up front.

| Code | Severity | Message |
|------|----------|---------|
| GS0298 | Error | The left-hand side of `??=` must be of nullable type. The operator only fills the slot when the current value reads as `nil`, so a non-nullable target is a no-op (and almost always a programmer error). |
| GS0299 | Error | The left-hand side of `??=` must be assignable: a variable, parameter, field, property, or indexer. Method-call results, parenthesized expressions, and literals are not accepted. |

Cause/fix examples:

- **GS0298** — `var s = "hi"; s ??= "x"`. Fix: declare the variable as `string?` if you intend to default a possibly-missing value; otherwise use a plain `=`. The compiler will not silently insert a no-op on a non-nullable target.
- **GS0299** — `compute() ??= "v"`. Fix: store the call result in a variable first and `??=` into the variable, or write the conditional store by hand. `??=` requires an lvalue.
- A read-only lvalue (`let x string? = nil; x ??= "v"`) reports the existing **GS0127** for parity with the simple-assignment path.

## Null-conditional indexing diagnostics (GS0300–GS0301)

ADR-0073 introduces the `a?[i]` null-conditional indexing operator. The diagnostics below cover the two shapes the binder rejects or warns up front.

| Code | Severity | Message |
|------|----------|---------|
| GS0300 | Warning | The receiver of `?[]` is non-nullable, so the null check is dead. Use `[]` instead. |
| GS0301 | Error | Null-conditional indexing `?[]` is not allowed on the left-hand side of an assignment. Use a plain `[]` after a nil-check, an `if let` binding, or the `??=` compound assignment instead. |

Cause/fix examples:

- **GS0300** — `var a = []int32{1,2}; var x = a?[0]`. Fix: the receiver type `[]int32` is non-nullable, so write `a[0]` directly. `?[]` is intended for receivers whose static type permits `nil`.
- **GS0301** — `dict?["k"] = 1`. Fix: nullable receivers do not have an addressable indexed slot when the receiver is nil; check first (`if dict != nil { dict["k"] = 1 }`) or use a non-nullable local that you've already narrowed.

## Switch-expression arm separator deprecation (GS0302)

ADR-0074 makes `->` the lambda operator and migrates switch-expression arms to use `:` as the pattern/value separator. The legacy `->` arm form remains accepted for one release to ease migration, but every legacy arm produces a warning.

| Code | Severity | Message |
|------|----------|---------|
| GS0302 | Warning | `->` in a switch-expression arm is deprecated; use `:` instead (ADR-0074). |

Cause/fix:

- **GS0302** — `let label = switch x { case 0 -> "zero"; default -> "other" }`. Fix: replace each `->` between the pattern and the arm value with `:`, e.g. `case 0: "zero"; default: "other"`. The behaviour is otherwise identical. A future release will remove the legacy form and turn it into a parse error.

## Function-type clause `func(...)` deprecation (GS0303)

ADR-0075 makes `(T1, T2, ...) -> R` the canonical function-type clause spelling — the type spelling now matches the lambda expression form introduced in ADR-0074. The legacy `func(...) R` and `async func(...) R` type-clause spellings remain accepted for one release to ease migration, but every legacy occurrence produces a warning.

| Code | Severity | Message |
|------|----------|---------|
| GS0303 | Warning | `func(...)` function-type clauses are deprecated; use `(T) -> R` instead (ADR-0075). |

Cause/fix:

- **GS0303** — `var f func(int32) int32 = (x int32) -> x + 1`. Fix: rewrite the type clause as `var f (int32) -> int32 = (x int32) -> x + 1`. Async variant: `async func(int32) int32` → `async (int32) -> int32`. The deprecation applies **only** to `func` in *type-clause* positions; function *declarations* (`func name(...) R { … }`), function *literals* (`func(...) R { … }` expressions), and `delegate func(...)` named-delegate declarations all keep `func`. A future release will remove the legacy type-clause spelling and turn it into a parse error.


## Lambda binding type-inference diagnostics (GS0304)

ADR-0076 introduces type inference for `let` / `var` bindings whose initializer is a lambda. When the lambda's parameters are fully typed, the binding's type is inferred to the lambda's `(T1, ...) -> R` function type and the user does not need to repeat the function-type clause. If neither side resolves to a concrete type — the binding has no explicit type clause AND the lambda's parameter types are not spelled — the binder reports `GS0304`.

| Code | Severity | Message |
|------|----------|---------|
| GS0304 | Error | Cannot infer the type of `<name>` from a lambda with untyped parameters; supply a function-type clause on the binding or annotate the lambda parameters (ADR-0076). |

Cause/fix:

- **GS0304** — `let f = (x) -> x + 1`. Either side may carry the types. Spell the lambda parameters: `let f = (x int32) -> x + 1`, or spell the binding: `let f (int32) -> int32 = (x) -> x + 1`. Generic method calls that take a lambda (for example `xs.Where(x -> x > 0)`) still use the existing method-type-inference path and are unaffected.

## `:=` short variable declaration removal (GS0305)

ADR-0077 removes the Go-style `:=` short variable declaration from the
language. The lexer still tokenizes `:=` so the parser can produce a
targeted, span-accurate diagnostic with a context-sensitive migration
suggestion instead of cascading parse errors. Every occurrence of `:=`
— at statement scope, in multi-target assignment, in `for` / `await for`
range and ellipsis loops, in `if` / `for` simple-statement initialisers,
and in `select` case bindings — emits `GS0305`.

| ID | Severity | Message |
|----|----------|---------|
| GS0305 | Error | `':=' short variable declaration has been removed; use 'let' (immutable) or 'var' (mutable) instead (e.g. '<migration>') (ADR-0077).` |

Cause/fix:

- **GS0305** — `x := 1`. Use `let x = 1` when the binding is never
  rebound, or `var x = 1` when it is. For looping forms: `for i := 0 ...
  10` → `for i in 0 ... 10`, `for v := range xs` → `for v in xs`, `for
  k, v := range dict` → `for k, v in dict`, `await for x := range seq` →
  `await for x in seq`, `case v := <-ch { … }` → `case let v = <-ch { …
  }`. The three-part `for` init slot accepts a `var`/`let` declaration,
  e.g. `for var i = 0; i < n; i++` (previously written as `for i := 0;
## Kotlin/Swift-style type-declaration head (GS0306–GS0313)

ADR-0078 (issue #718) removes the legacy `type Name <kind> ...` aggregate
head and the `record` keyword. The aggregate keyword (`class`, `struct`,
`enum`, `interface`) is the declaration keyword. These diagnostics
catalogue the invalid combinations and the legacy migrations. See
[ADR-0078](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0078-kotlin-style-type-declaration-grammar.md)
for the full grammar and rationale.

| ID | Severity | Message |
|----|----------|---------|
| GS0306 | Error | Legacy `type Name <kind>` aggregate declaration — drop `type`; the kind keyword is now the head (ADR-0078). |
| GS0307 | Error | The `record` keyword has been removed (ADR-0078); use `data struct Name` (value-typed) or `data class Name` (reference-typed). |
| GS0308 | Error | `inline` is only legal on `struct` declarations (ADR-0078). |
| GS0309 | Error | `open` is only legal on `class` declarations (ADR-0078). |
| GS0310 | Error | `sealed` is only legal on `class` and `interface` declarations (ADR-0078). |
| GS0311 | Error | `data` and `inline` are mutually exclusive (ADR-0078). |
| GS0312 | Error | `open` and `sealed` are mutually exclusive (ADR-0078). |
| GS0313 | Warning | Non-exhaustive `switch` over a sealed-hierarchy base or discriminated-union enum (ADR-0078). |

Cause/fix:

- **GS0306** — `type Foo class { … }` → `class Foo { … }`. Same for
  `struct`, `enum`, `interface`. Type aliases (`type Count = int32`) and
  named delegates (`type Greeter = delegate func(name string)`) are
  unaffected.
- **GS0307** — `record Point { x int32; y int32 }` →
  `data struct Point(x int32, y int32)` (preserves value semantics) or
  `data class Point(x int32, y int32)` if reference semantics are
  desired.
- **GS0308** — `inline class Foo` → `inline struct Foo`. Inline classes
  do not exist; the wrapper must be a value type.
- **GS0309** — `open struct Foo`, `open enum Foo`, `open interface Foo`
  → drop `open`. Structs cannot be inherited from, enums and interfaces
  are open by default.
- **GS0310** — `sealed struct Foo` → drop `sealed`. `sealed enum Foo` →
  use a discriminated-union enum (`enum Foo { … }` with payload-bearing
  cases) or drop `sealed`.
- **GS0311** — `data inline struct Foo` → choose one (`data struct` for
  the record contract, `inline struct` for the newtype wrapper).
- **GS0312** — `open sealed class Foo` → choose one. `open` admits
  cross-package subclasses; `sealed` is the closed Kotlin hierarchy.
- **GS0313** — Add missing cases to the `switch`, or add a default arm.
  For `sealed class Shape` with subclasses `Circle`, `Square`, write
  `switch s { case c is Circle: ... case sq is Square: ... }`.

## Owned-receiver method warning (GS0314)

ADR-0079 (issue #719) restricts Go-style receiver-clause methods to types
this package does **not** own. Same-package owned-type instance methods
should be declared inside the type body; the receiver-clause form is
reserved for non-owned types (imported CLR types, BCL primitives, and
types declared by referenced packages). See
[ADR-0079](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0079-restrict-receiver-clauses-to-non-owned-types.md)
for the full rationale.

| ID | Severity | Message |
|----|----------|---------|
| GS0314 | Warning | `Receiver-clause methods are reserved for types this package does not own; declare '<MethodName>' as a member of '<TypeName>' instead (ADR-0079).` |

Cause/fix:

- **GS0314** — `func (p Point) Distance() int32 { ... }` where `Point` is
  declared in the same package. Move the declaration into the class body
  (`class Point { ... func Distance() int32 { ... } }`) and drop the
  receiver clause. Cross-package and CLR receivers (`func (sb StringBuilder)
  Reset() ...`) are unaffected. Operator overloads (`func (a Vector2)
  operator +(b Vector2) Vector2 { ... }`) are exempt because operators
  have no in-body form today. Suppress per-project via
  `<NoWarn>GS0314</NoWarn>` if migration must be deferred — but note
  this is a one-release grace period; a future ADR may escalate to error.

## Named-argument `=` separator deprecation (GS0315)

ADR-0080 (issue #720) deprecates the legacy `name = value` named-argument
spelling. The canonical spelling is `name: value` (issue #343). The `=`
form was retained for back-compat by ADR-0032 (`.copy(field = value)`
sugar) and ADR-0047 (attribute named arguments) and is still accepted
this release; a warning fires so existing source can be migrated before
the `=` branch is removed in a later release. See
[ADR-0080](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0080-deprecate-equals-named-arguments.md)
for the full rationale and follow-up plan.

| ID | Severity | Message |
|----|----------|---------|
| GS0315 | Warning | `Named argument '<name>' uses the deprecated '=' separator; use '<name>: value' instead (ADR-0080).` |

Cause/fix:

- **GS0315** — `Foo(timeout = 30)` — rewrite the named-argument separator
  as `:` (`Foo(timeout: 30)`). Migrate `.copy(...)` and attribute
  argument lists alongside ordinary call sites:
  `p.copy(x = 10)` → `p.copy(x: 10)`,
  `@AttributeUsage(All, AllowMultiple = true)` → `@AttributeUsage(All, AllowMultiple: true)`.
  Plain assignment expressions (`x = 1`), optional parameter defaults
  (`func f(x int32 = 0)`), and `with`-expression field initializers
  (`p with { x = 10 }`) parse on separate paths and are unaffected.
  Suppress per-project via `<NoWarn>GS0315</NoWarn>` if migration must
  be deferred — but note this is a one-release grace period; the `=`
  branch is removed in a later release.

## `null` identifier "did you mean nil?" diagnostic (GS0273)

ADR-0081 (issue #721) pins the contract for the C# spelling `null` used
in a G# source where the canonical null literal is `nil` (ADR-0001).
`null` is **not** a keyword in G# — it parses as an ordinary identifier
and resolves through normal symbol lookup. When the identifier `null`
is used in a value-expression position and no symbol named `null` is
in scope, the binder emits `GS0273` and recovers by treating the
identifier as `nil` so target-type contexts (e.g.
`let x string? = null`, `Foo(null)` where `Foo` takes `T?`, or
`x == null`) continue to typecheck without cascading errors.

| ID | Severity | Message |
|----|----------|---------|
| GS0273 | Error | `'null' is not a literal in G#. Did you mean 'nil'?` |

Cause/fix:

- **GS0273** — `let x string? = null`, `Foo(null)` where `Foo` takes
  `T?`, `x == null`. Replace `null` with `nil` (`let x string? = nil`,
  `Foo(nil)`, `x == nil`). The diagnostic is anchored at the `null`
  token. GS0273 does **not** fire when a symbol named `null` is in
  scope — `let null = "hi"; let s = null` and
  `func null() int32 { return 42 }; let v = null()` both resolve
  normally with no diagnostic. See
  [ADR-0081](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0081-null-identifier-did-you-mean-nil.md)
  for the full rule, scope, and recovery rationale.

## Go-flavored concurrency requires `import Gsharp.Extensions.Go` (GS0316)

ADR-0082 (issue #722) pins the per-file gate on the Go-flavored
concurrency surface. The production concurrency surface is `scope` +
`async`/`await`; the Go-flavored shapes (`go`, `chan T`, `<-` send,
`<-` receive, `select`, `close(ch)`, `make(chan T[, cap])`) remain
available but are opt-in. The binder checks for `import
Gsharp.Extensions.Go` in the current compilation unit (not the
project) before binding any of the gated forms and emits `GS0316`
when the import is absent. The triggering form is named in the
message so users see exactly what to add.

| ID | Severity | Message |
|----|----------|---------|
| GS0316 | Error | `'<form>' is provided by 'Gsharp.Extensions.Go'. Add 'import Gsharp.Extensions.Go' or use 'scope' + 'async'/'await' instead (ADR-0082).` |

Cause/fix:

- **GS0316** — any use of `go`, `chan` (in a type clause or inside
  `make`), `<-` (send or receive), `select`, or `close(ch)` in a
  source file that does not contain `import Gsharp.Extensions.Go`.
  Add the import at the top of the file (right after the `package`
  declaration is canonical), or rewrite the code on the
  `scope` + `async`/`await` surface. The diagnostic is anchored at
  the offending keyword/operator (`go`, `chan`, `<-`, `select`,
  `close`); each `make(chan T)` site is reported once at its inner
  `chan` keyword. The gate is **always opt-in**: `/noimplicitimports`
  does not interact with it, and the implicit `System` import
  toggle has no effect on whether `Gsharp.Extensions.Go` is in scope.
  See ADR-0082 for the full rule, recovery strategy, and packaging
  rationale.

## Go-style built-ins require `import Gsharp.Extensions.Go` (GS0317)

ADR-0083 (issue #723) extends the per-file gate from ADR-0082
to the Go-style built-in functions `len`, `cap`, `append`, and
`delete`. The binder checks for `import Gsharp.Extensions.Go`
in the current compilation unit before resolving any of these
identifiers as built-ins and emits `GS0317` when the import is
absent. The message names the offending built-in and, when there
is a clean .NET-idiomatic replacement, names the replacement
too — so users can fix the call site either by adding the
import or by switching to the BCL equivalent.

| ID | Severity | Message |
|----|----------|---------|
| GS0317 | Error | `'<name>' is provided by 'Gsharp.Extensions.Go'. Add 'import Gsharp.Extensions.Go' or call '<suggestion>' directly (ADR-0083).` |

`<suggestion>` is selected from the following table based on the
built-in identifier and the bound type of its primary receiver:

| Built-in | Receiver | `<suggestion>` |
|----|----|----|
| `len` | array / slice / string | `.Length` |
| `len` | map | `.Count` |
| `delete` | map | `.Remove(k)` |
| `append` | slice | `List[T].Add` |
| `cap` | any | — (import-only variant: "Add 'import Gsharp.Extensions.Go' (ADR-0083).") |

The diagnostic is anchored at the built-in identifier token. The
`close(ch)` and `make(chan T)` shapes are part of the channel
cluster and keep firing **GS0316** (ADR-0082) rather than
GS0317 — the suggested fix is the same import, but the message
frames the `scope` + `async`/`await` alternative for the
channel surface. The two diagnostics share the same
`BinderContext.IsGoExtensionsImported` predicate, so a single
`import Gsharp.Extensions.Go` unlocks both clusters at once.

Recovery is identical to GS0316: the binder reports GS0317 and
continues binding the call as if the import were present, so
subsequent shape diagnostics (e.g. `GS0117` for a wrong-typed
argument) still surface in the same pass.

Cause/fix:

- **GS0317** — any call to `len`, `cap`, `append`, or `delete`
  in a source file that does not contain
  `import Gsharp.Extensions.Go`. Add the import at the top of
  the file (right after the `package` declaration is canonical),
  or switch to the .NET-idiomatic alternative named in the
  message: `array.Length` / `slice.Length` / `string.Length`
  for `len` on length-bearing values, `map.Count` for `len` on
  maps, `map.Remove(k)` for `delete`, and `List[T].Add` for
  the mutable-list shape of `append`. See ADR-0083 for the
  full rule and the deconfliction note with GS0316.



## Default-interface-method diagnostics (GS0318–GS0321)

See ADR-0085 (which supersedes the deferral in ADR-0018).
Interfaces may now expose default-method bodies; classes that
implement the interface inherit the default unless they declare
their own override. The four diagnostics below cover the conflict,
dropped-default, missing-implementer, and deferred-modifier cases.

| ID | Severity | Description |
|----|----------|-------------|
| GS0318 | Error | `Class '<C>' inherits conflicting default implementations of '<Name>' from interfaces '<IA>' and '<IB>'. Declare '<C>.<Name>' explicitly to disambiguate.` |
| GS0319 | Error | `Override targets default-interface method '<Name>' that was removed in interface '<I>'.` |
| GS0320 | Error | `Class '<C>' does not implement interface method '<I>.<Name>' and the interface does not provide a default.` |
| GS0321 | Error | `Modifier '<modifier>' on interface method '<Name>' is not yet supported. ADR-0085 explicitly defers 'open', 'override', and 'sealed override' interface members.` |
| GS0368 | Error | `Interface method '<Name>' has no body and must be terminated with ';' (ADR-0085); a bodyless 'func' uses ';' as its no-body marker, mirroring P/Invoke.` |

Note: as of ADR-0090 (issue #756) the `private` modifier on an interface
method is no longer deferred and no longer fires GS0321. See the
"Private interface helper diagnostics" section below for the GS0334–GS0337
codes that govern private-helper visibility and override-clash detection.
Per the issue #865 revision of ADR-0089, interface static-virtual members
no longer use a `static` modifier — they are declared inside a
`shared { … }` block on the interface — so `static` is no longer recognised
on interface methods at all (the old `static func …` shape now produces a
generic parser error). GS0321 therefore only fires today for `open`,
`override`, and `sealed override` on interface methods.

Default-interface methods (DIM) emit standard CLR DIM metadata: the
interface's method table carries a `.method virtual` slot whose body
lives on the interface TypeDef. Implementers inherit the default
through normal virtual dispatch; an explicit override on the class
replaces it. Cross-language consumers (C# / VB / F#) see the DIM as
a regular C# 8+ default interface method.

The historical GS0186 diagnostic ("Interface method may not have a
body.") is no longer emitted; ADR-0085 unblocks default-interface
methods. The slot is preserved for back-compat but the binder no
longer fires it.

Cause/fix:

- **GS0318** — declare an explicit override on the class to pick
  which inherited default wins, or call the desired interface's
  default by qualifying the call site. The explicit-base call
  syntax (`base<IFoo>.Method()`) is deferred per ADR-0085.
- **GS0319** — reserved for the version-skew scenario where a
  consumer's referenced library has been upgraded to drop a
  default. Restore the default or supply a class-level override.
- **GS0320** — provide a method body on the implementing class
  with the matching signature, or add a default body to the
  interface declaration.
- **GS0368** — terminate the body-less interface method (or
  abstract `shared { … }` static slot) with `;`, the universal
  no-body marker for `func` declarations (issue #881). A method
  with a `{ … }` body takes no `;`.
- **GS0321** — remove the deferred modifier. Static interface
  members, private helper methods, and `sealed override` are
  deferred follow-ups; instance-virtual default-interface
  methods are the only DIM shape supported in this release.


## P/Invoke diagnostics (GS0322–GS0329)

See ADR-0086 (issue #727). G# accepts a function whose body is a
single `;` token as a P/Invoke declaration when the function is
annotated with `@DllImport("libname", ...)`. The compiler emits CLR
`PinvokeImpl` metadata (ImplMap + ModuleRef) for these declarations;
the runtime resolves the call at first invocation. The historical
blanket-rejection at GS0211 has been retired.

| ID | Severity | Description |
|----|----------|-------------|
| GS0322 | Error | `@DllImport` requires a non-empty library name as its first positional argument. |
| GS0323 | Error | P/Invoke parameter or return type `<type>` is not in the supported marshalling table (ADR-0086 §2). |
| GS0324 | Error | Function `<name>` is annotated `@DllImport` but has a managed body; P/Invoke declarations must use a `;` body. |
| GS0325 | Error | Function `<name>` has no body; only `@DllImport`-annotated functions may use a `;` body marker. |
| GS0326 | Error | `@DllImport` is not supported on this function shape (`<reason>`). |
| GS0327 | Error | `@DllImport` `CharSet` value `<value>` is not recognised. |
| GS0328 | Error | `@DllImport` `CallingConvention` value `<value>` is not recognised. |
| GS0329 | Error | `@DllImport` `EntryPoint` must be a non-empty string. |

> The codes above also fire for the modern `@LibraryImport` attribute
> wherever they apply (`@LibraryImport` reuses the same library-name,
> body-shape, unsupported-type, and `EntryPoint` checks). `CharSet`
> (GS0327) and `CallingConvention` (GS0328) cannot fire under
> `@LibraryImport` because those knobs do not exist on the attribute —
> use `StringMarshalling:` (GS0343 / GS0344) and `[UnmanagedCallConv]`
> instead.

The supported v1 marshalling table is: every primitive integer
(`int8`/`16`/`32`/`64`, `uint8`/`16`/`32`/`64`), `nint`/`nuint`,
`float32`/`float64`, `bool`, `char`, `string` (governed by
`CharSet`), single-element-typed `*T` byref-style pointers
(`*T` where `T` is primitive), and slices of primitives. Anything
else surfaces as GS0323.

Cause/fix:

- **GS0322** — supply the library name: `@DllImport("libc")`.
- **GS0323** — change the parameter or return to a supported
  marshalling type; struct marshalling, function-pointer
  marshalling, and custom marshallers are deferred follow-ups.
- **GS0324** — drop the function body and replace it with `;`,
  or remove the `@DllImport` annotation.
- **GS0325** — add `@DllImport("libname")` above the declaration,
  or replace the `;` with a managed body `{ ... }`.
- **GS0326** — make the function a plain top-level `func`: not
  `async`, not generic, no receiver, no `ref` return, no `shared`
  block. These are deferred follow-ups.
- **GS0327** / **GS0328** — use one of the documented enum members
  (e.g. `CharSet.Ansi`, `CallingConvention.Cdecl`).
- **GS0329** — `EntryPoint` must be a non-empty literal string;
  omit the argument to default to the G# function's identifier.

See ADR-0086 for the worked example, the attribute-knob table
(`EntryPoint`, `CharSet`, `SetLastError`, `CallingConvention`,
`ExactSpelling`, `PreserveSig`, `BestFitMapping`,
`ThrowOnUnmappableChar`), and the deferred-features list.


## Static-virtual interface-member diagnostics (GS0330–GS0333)

See ADR-0089 (issue #755) and its issue #865 revision. The DIM family
lands in ADR-0085; ADR-0089 extends interfaces with C# 11-style
*static-virtual* members. Per issue #865, these members are declared
inside a `shared { … }` block on the interface — the same `shared { … }`
block that hosts static members on classes and structs (ADR-0053). A
body-less `func` inside that block is an abstract static-virtual slot;
a `func` carrying a body is a default static-virtual member.
Implementers supply the static via their own `shared { ... }` block;
generic methods can dispatch through `T.M(...)` and the call site
resolves to the implementer's static method
(`constrained. !!T  call <iface>::<method>` at the CLR level —
ECMA-335 II.15.4.2.4 and III.2.1).

| ID | Severity | Description |
|----|----------|-------------|
| GS0330 | Error | `Only 'func' members are allowed inside the 'shared' block of interface '<Name>'; interface static state is not supported in this release (ADR-0089).` |
| GS0331 | Error | `<Kind> '<C>' does not implement static-virtual interface method '<I>.<Name>', and the interface provides no default body (ADR-0089).` |
| GS0332 | Error | `<Kind> '<C>' declares instance method '<Name>' but interface '<I>.<Name>' is static-virtual; declare it inside a 'shared { … }' block (ADR-0089).` |
| GS0333 | Error | `Type parameter '<T>' has no constraint that declares a static-virtual member '<Name>' (ADR-0089).` |

Static-virtual interface members emit the standard CLR shape:
the interface's MethodDef carries
`Static | Virtual | Abstract | NewSlot` (no body, RVA = 0) for
the abstract case, or `Static | Virtual | NewSlot` (with a body)
for the default case. The implementer declares the method as
`Static` (no `Virtual` / `NewSlot`) and is paired to the
interface slot via a `MethodImpl` row (ECMA-335 II.22.27).

Cause/fix:

- **GS0330** — only `func` members may appear inside an interface's
  `shared { … }` block. Remove any `var` / `let` / `const` / `prop` /
  `event` declarations from that block; per-implementer static state
  on interfaces is a future extension and not yet supported. If you
  want a per-implementer constant today, expose it through a
  static-virtual property or function and have each implementer
  return its value.
- **GS0331** — add the missing static override inside the
  implementer's `shared { … }` block:
  `class Adder : IAdd { shared { func Add(a int32, b int32) int32 { return a + b } } }`,
  **or** give the interface method a default body so
  implementers may omit it.
- **GS0332** — move the method into the implementer's
  `shared { … }` block. An instance method cannot satisfy a
  static-virtual slot because the CLR routes the call through
  the type, not through an instance receiver.
- **GS0333** — change the receiver to a type parameter whose
  constraint actually declares the slot. For example,
  `func Sum[T IAdd](xs sequence[T]) T { … T.Add(a, b) … }`
  requires `T` to be constrained by `IAdd` — the interface that
  declares the static-virtual `Add`.

Cross-references:

- ADR-0085 — default-interface methods (the DIM family parent).
- ADR-0089 — static-virtual interface members (this feature).
- ADR-0090 — `private` interface helper methods (the GS0334–GS0337 family).
- Issue #755 (this feature), #756 (private interface members,
  delivered in ADR-0090), #757 (explicit-base call from interface
  bodies, deferred).


## Private interface helper diagnostics (GS0334–GS0337)

See ADR-0090 (issue #756). The DIM family lands in ADR-0085;
ADR-0090 extends it with C# 8-style `private` helper methods
inside an `interface` body. A private helper is part of the
interface's own implementation — only sibling members of the
same interface may call it. Implementers cannot see the helper
and cannot supply an override; the helper is non-virtual and
not part of the interface's v-table.

| ID | Severity | Description |
|----|----------|-------------|
| GS0334 | Error | `Private interface member '<I>.<Name>' is not accessible from this context; private helpers are visible only to sibling members of the same interface (ADR-0090).` |
| GS0335 | Error | `Private interface method '<I>.<Name>' must declare a body; abstract private helpers are not allowed (ADR-0090).` |
| GS0336 | Error | `<Kind> '<C>' declares method '<Name>' that clashes with private interface helper '<I>.<Name>'; private interface helpers are interface-internal and cannot be overridden by implementers (ADR-0090).` |
| GS0337 | Error | `Modifier 'private' on interface member '<Name>' of kind '<Kind>' is not supported by ADR-0090. The v1 surface accepts 'private' only on instance / static methods.` |

Private interface helpers emit the standard CLR shape:
`MethodAttributes.Private | HideBySig` (instance), plus
`MethodAttributes.Static` when combined with ADR-0089's
static form. The helper is **not** stamped `Virtual` /
`NewSlot` / `Abstract` and carries an IL body on the interface
TypeDef. Sibling default bodies dispatch to the helper via
implicit `this` (instance) or implicit static-self (static).

Cause/fix:

- **GS0334** — remove the call site outside the interface,
  or expose the helper functionality by adding a public default
  method on the interface that wraps it. Implementers cannot
  invoke private helpers because they were never part of the
  contract; the helper is an implementation detail.
- **GS0335** — supply a body for the helper:
  `private func Helper(x int32) int32 { return x + 1 }`.
  Abstract private helpers do not make sense — implementers
  cannot satisfy them.
- **GS0336** — rename the implementer's method, or fold the
  logic into a public method on the interface. The CLR slot
  the implementer was trying to override is private to the
  interface and not part of the public contract.
- **GS0337** — restrict `private` to method members. The v1
  ADR-0090 surface defers `private` on properties / events to
  a follow-up.

Cross-references:

- ADR-0085 — default-interface methods (the DIM family parent).
- ADR-0089 — static-virtual interface members (interaction with
  private static helpers).
- ADR-0090 — `private` interface helper methods (this feature).
- Issue #756 (this feature), #726 (DIM parent), #755
  (static-virtual interfaces), #706 (advanced-interfaces parent).


## Explicit-base interface call diagnostics (GS0338–GS0341)

See ADR-0091 (issue #757). ADR-0091 introduces the
explicit-base call syntax `base[IFoo].Method(args)` for disambiguating
default-interface-method (DIM) diamonds. The override may delegate to
one — or both — of the inherited defaults rather than re-implement
them. The emit shape is a non-virtual `call instance R IFoo::Method(...)`
so the inherited body is invoked directly rather than re-dispatched
through the v-table.

| ID | Severity | Description |
|----|----------|-------------|
| GS0338 | Error | `'base[<I>]' is not allowed here; the enclosing type does not implement '<I>'.` |
| GS0339 | Error | `Interface '<I>' does not declare a member named '<Name>' reachable via 'base[<I>]'.` |
| GS0340 | Error | `Interface member '<I>.<Name>' is abstract; there is no default implementation to delegate to via 'base[<I>]'.` |
| GS0341 | Error | `Interface member '<I>.<Name>' is a private helper (ADR-0090) and is not reachable via 'base[<I>]'.` |

`base[IFoo]` may be used inside any instance member (public, private,
override, or non-conflicting) of a class that implements `IFoo`. It is
not a statement and never appears outside an instance-member body.
Private interface helpers (ADR-0090) are interface-internal and never
exposed through `base[IFoo]`; that boundary is enforced by GS0341
rather than the helper visibility diagnostic GS0334.

Cause/fix:

- **GS0338** — either add the interface to the enclosing type's
  implementation set (`class C : IFoo { ... }`) or remove the
  `base[IFoo]` call. A top-level function has no enclosing type and
  cannot use the syntax.
- **GS0339** — check the spelling, arity, or visibility of the member.
  `base[IFoo]` reaches only members declared on `IFoo` itself (not
  inherited from another interface and not on a base class).
- **GS0340** — the interface declares the slot but did not supply a
  default body. There is nothing to delegate to. Either supply a
  default body on the interface, or implement the body inline in the
  class.
- **GS0341** — private interface helpers are an internal interface
  detail (ADR-0090). They are not part of the contract that
  implementers see and cannot be invoked across the
  implementer / interface boundary, even via `base[IFoo]`. Add a
  public default on the interface that wraps the helper if you need
  to expose the functionality.

Cross-references:

- ADR-0085 — default-interface methods (the DIM family parent).
- ADR-0089 — static-virtual interface members (sibling).
- ADR-0090 — `private` interface helper methods (GS0341 boundary).
- ADR-0091 — explicit-base interface call syntax (this feature).
- Issue #757 (this feature), #726 (DIM parent), #755 (static-virtual
  interfaces), #756 (private interface helpers), #706
  (advanced-interfaces parent).

## Base-class call diagnostics (GS0383–GS0385)

See ADR-0091 (issue #986). G# can call the **base class** implementation
of a virtual/overridable member non-virtually from within a derived type
using `base.Member(args)` — the faithful mapping of C# `base.M(...)` — or
the bracketed `base[BaseClass].Member(args)` form. Both emit
`ldarg.0` followed by a non-virtual `call instance R BaseClass::Member(...)`,
so the nearest base implementation runs without re-dispatching through
the v-table (no infinite recursion when called from the override that
shadows it). The bracketed selector names the *immediate* base class; the
member is resolved by walking the base chain, so a grandparent's
implementation is reached when the immediate base does not declare its
own override.

| ID | Severity | Description |
|----|----------|-------------|
| GS0383 | Error | `'base' is not valid here: '<T>' must be an instance member of a class that has a base class to use 'base.Member(...)'.` |
| GS0384 | Error | `Base class '<Base>' does not declare an accessible method named '<Name>' to call via 'base'.` |
| GS0385 | Error | `'base[<Type>]' is not valid: '<Type>' is not a base class of '<T>'. Use the immediate base class name, or the plain 'base.Member(...)' form.` |

Cause/fix:

- **GS0383** — `base.Member(...)` is only valid inside an instance member
  of a class that has a base class. It fires for top-level functions,
  `shared` statics, structs (no base class), and classes that derive only
  from `System.Object`. Move the call into an instance member of a derived
  class, or call the member directly.
- **GS0384** — the named member does not exist on any base class. Check the
  spelling, arity, or accessibility of the member. `base` reaches only
  members inherited from a base class.
- **GS0385** — the type named in the brackets is not a base class of the
  enclosing type. Use the immediate base class name, or prefer the plain
  `base.Member(...)` form, which resolves the base chain automatically.

Cross-references:

- ADR-0091 — explicit-base interface call syntax, extended by #986 to
  cover base-class calls.
- Issue #986 (this feature), #757 (base-interface call sibling).



## Abstract member diagnostics (GS0386–GS0388)

See issue #987. A no-body `open func F() R;` declared inside an `open class`
is the canonical G# spelling of a C# **`abstract`** method: it declares a
virtual slot with no implementation. A class that declares (or inherits
without overriding) an abstract method is itself **abstract** — it is emitted
with `TypeAttributes.Abstract` and cannot be instantiated. Concrete
(non-`open`) subclasses must override every inherited abstract member; an
`open` subclass may leave them abstract and remain abstract itself.

```gsharp
open class Shape {
    open func Area() float64;          // abstract member — no body, just ';'
}

class Circle(R float64) : Shape {
    override func Area() float64 { return 3.14159 * R * R }
}

let s Shape = Circle(2.0)              // OK — Circle is concrete
Console.WriteLine(s.Area().ToString()) // 12.566… via virtual dispatch
```

| ID | Severity | Description |
|----|----------|-------------|
| GS0386 | Error | `Cannot create an instance of the abstract type '<T>'.` |
| GS0387 | Error | `'<Derived>' does not implement inherited abstract member '<Base>.<Member>'.` |
| GS0388 | Error | `Abstract method '<M>' must be declared 'open' inside an 'open class'; '<T>' is not open or the method omits 'open'.` |

Cause/fix:

- **GS0386** — an abstract class cannot be constructed (`Shape()` /
  `new Shape()`). Construct a concrete subclass that overrides every abstract
  member instead. Mirrors C# CS0144.
- **GS0387** — a concrete (non-`open`) class derives from an abstract base
  but does not override one of the inherited abstract members. Either provide
  an `override func` for the member, or declare the subclass `open` (it then
  stays abstract itself). Mirrors C# CS0534.
- **GS0388** — a no-body (abstract) method appeared where it is not permitted.
  An abstract member must be declared `open` and may only live inside an
  `open class`. Add the `open` modifier and/or make the enclosing class
  `open`, or give the method a `{ … }` body. Mirrors C# CS0513/CS0500.

Cross-references:

- Issue #987 (this feature); ADR-0017 (`open`/`override` model), ADR-0115 §G
  (cs2gs migration mapping for C# `abstract`).



## `@LibraryImport` P/Invoke diagnostics (GS0342–GS0345)

See ADR-0092 (issue #758). G# accepts the modern
source-generator-shaped `@LibraryImport(...)` attribute on `;`-bodied
`func` declarations. The compiler emits an explicit managed marshalling
stub (outer wrapper) that calls a hidden blittable inner P/Invoke, so
the runtime never auto-marshals at the unmanaged boundary. The
attribute reuses the same library-name, body-shape, unsupported-type,
and `EntryPoint` checks as `@DllImport` (GS0322–GS0329); the codes below
cover the surface that is unique to `@LibraryImport`.

| ID | Severity | Description |
|----|----------|-------------|
| GS0342 | Error | Function `<name>` is annotated with both `@DllImport` and `@LibraryImport`; choose one. |
| GS0343 | Error | `StringMarshalling` value `<value>` is not a valid `StringMarshalling` member; use `Utf8` or `Utf16`. |
| GS0344 | Error | `@LibraryImport` function `<name>` has a `string` surface and must specify `StringMarshalling: StringMarshalling.Utf8` or `StringMarshalling.Utf16`. |
| GS0345 | Error | `@LibraryImport` function `<name>` has a `string` return type; v1 supports `string` only as a parameter type (see ADR-0092 §2). |

Cause/fix:

- **GS0342** — pick exactly one P/Invoke attribute per declaration.
  `@DllImport` and `@LibraryImport` express the same intent through two
  different emit pipelines; mixing them is ambiguous.
- **GS0343** — only `StringMarshalling.Utf8` and `StringMarshalling.Utf16`
  are accepted in v1. `Custom` (and `StringMarshallingCustomType`) is
  reserved for a future custom-marshaller ADR.
- **GS0344** — supply an explicit `StringMarshalling` argument whenever
  any `string` parameter is present. Unlike `@DllImport`, the modern
  attribute does not assume a default encoding.
- **GS0345** — declare an out-of-band buffer or use `nint` and call
  `Marshal.PtrToStringUTF8` from G# instead. Returning a managed
  `string` from `@LibraryImport` requires a deallocator contract that
  v1 does not surface.

Cross-references:

- ADR-0086 — original P/Invoke / `@DllImport` ADR (the `@LibraryImport`
  deferral in §4 is superseded by ADR-0092).
- ADR-0092 — `@LibraryImport` source-generator-shaped P/Invoke (this
  feature).
- Issues #758 (this feature), #727 (original P/Invoke), #706
  (native-interop parent).


## Struct / class P/Invoke marshalling diagnostics (GS0346–GS0351)

See ADR-0093 (issue #759). G# accepts `@StructLayout(LayoutKind.…)` on
`struct` and `class` declarations, and `@FieldOffset(N)` on the fields
of an `Explicit`-layout type. Both attributes are CLR
*pseudo-custom attributes* — the runtime reconstructs them at reflection
time from the `ClassLayout` and `FieldLayout` metadata-table rows, so
the emitter writes those rows directly and skips the normal
`CustomAttribute` round-trip. The diagnostics below cover the surface
unique to struct / class marshalling; existing P/Invoke type-check codes
(GS0322–GS0329 for `@DllImport`, GS0342–GS0345 for `@LibraryImport`)
continue to apply for the surrounding signature.

| ID | Severity | Description |
|----|----------|-------------|
| GS0346 | Error | `@StructLayout(LayoutKind.<value>)` is not supported; v1 P/Invoke marshalling accepts only `LayoutKind.Sequential` and `LayoutKind.Explicit`. |
| GS0347 | Error | Field `<field>` of explicit-layout struct `<type>` is missing a `@FieldOffset(N)` annotation; every field of an `Explicit`-layout type must carry one. |
| GS0348 | Error | `@FieldOffset` on field `<field>` of `<type>` is only valid inside an `Explicit`-layout type; declare `@StructLayout(LayoutKind.Explicit)` on the enclosing struct or drop the annotation. |
| GS0349 | Error | Type `<type>` is not blittable and cannot appear in a P/Invoke signature without per-field `@MarshalAs` (deferred); rewrite the type to use blittable fields only. |
| GS0350 | Error | `@FieldOffset(<value>)` value is not a valid non-negative `int32`. |
| GS0351 | Error | Class `<type>` cannot be used as the return type of a P/Invoke function; return a struct or `nint` instead. |

Cause/fix:

- **GS0346** — `LayoutKind.Auto` is rejected because the CLR is free to
  reorder fields, which breaks the bit-for-bit ABI contract the native
  side relies on. Pick `Sequential` for "matches the C declaration
  order" or `Explicit` for "I'm describing a union or padded layout".
- **GS0347** — Explicit layout means *every* field's offset is your
  responsibility; an unannotated field would land at offset 0 by
  default and silently alias the first explicitly-placed field. Add the
  intended `@FieldOffset(N)`.
- **GS0348** — `@FieldOffset` only has a defined meaning inside an
  `Explicit`-layout type. On a `Sequential`-layout type the CLR
  computes offsets from the declaration order and `Pack` setting;
  carrying the attribute would be misleading.
- **GS0349** — blittability is checked recursively per ADR-0093 §2: a
  type is blittable iff every field is a primitive integer / float, a
  pointer (`*T`), or a blittable nested struct. `bool`, `char`,
  `string`, `decimal`, slices, sequences, and unannotated classes are
  non-blittable in v1. Per-field `[MarshalAs]` is deferred to a
  follow-up.
- **GS0350** — `@FieldOffset` accepts a non-negative `int32` literal
  (typically `0`, `4`, `8`, …); other forms (negative, non-integer,
  expression) are rejected.
- **GS0351** — classes can only be marshalled *by reference* across the
  P/Invoke boundary; returning a managed object reference from a native
  function requires a deallocator contract that v1 does not surface.
  Return a struct or pass an `nint` and reconstruct the object on the
  managed side.

Cross-references:

- ADR-0086 — original P/Invoke / `@DllImport` ADR.
- ADR-0092 — `@LibraryImport` source-generator-shaped P/Invoke.
- ADR-0093 — struct and class marshalling (this feature).
- ADR-0094 — `ref` / `out` / `in` parameter marshalling (closes #760).
- Issues #759 (this feature), #727 (original P/Invoke), #758
  (`@LibraryImport`), #760 (`ref` / `out` / `in`), #706 (native-interop
  parent), #761 / #762 (planned follow-ups: function-pointer marshalling,
  per-field `[MarshalAs]` / custom marshallers).


## P/Invoke `ref` / `out` / `in` parameter diagnostic (GS0352)

See ADR-0094 (issue #760). G# now accepts `ref T`, `out T`, and `in T`
parameters on a `@DllImport` or `@LibraryImport` declaration, provided
the pointee type `T` is blittable. The runtime marshals the byref slot
as `T*` to the unmanaged callee, which is the canonical shape for libc
APIs like `time(time_t *)`, `clock_gettime(int, struct timespec *)`,
and `pipe(int [2])`.

| ID | Severity | Description |
|----|----------|-------------|
| GS0352 | Error | `'ref'/'out'/'in'` parameter `<name>` requires a blittable pointee; `<T>` is not blittable. Use a blittable primitive (`int8`…`int64`, `nint`/`nuint`, `float32`/`float64`), or a struct annotated with `@StructLayout(LayoutKind.Sequential)`. |

Cause/fix:

- **`ref bool` / `ref char` is rejected.** The unmanaged width of `BOOL`
  is 4 bytes on Windows and 1 byte on POSIX; `char` is 1 byte natively
  but 2 in the CLR. There is no portable byref encoding without an
  explicit `@MarshalAs` (#762 follow-up). Declare the parameter as
  `ref uint8` (POSIX) or `ref int32` (Windows) and widen in user code.
- **`ref string` is rejected.** Strings need an explicit CoTaskMem
  allocate-before / free-after round trip; the byref slot would carry
  ownership ambiguity. Use `ref nint` together with
  `Marshal.StringToCoTaskMemUTF8` and `Marshal.PtrToStringUTF8`.
- **`ref T?` (nullable) is rejected.** The `Nullable<T>` layout
  (`{ T value; bool hasValue }`) is not blittable; passing the address
  would expose the `hasValue` byte to the unmanaged side, which has no
  contract for it.
- **`ref C` for a class `C` is rejected.** Classes already flow as
  pointers (per ADR-0093 §4) when annotated with `@StructLayout`. Adding
  a ref-kind on top produces a double indirection (`<TypeDef>**`) that
  the runtime marshaller cannot handle. Drop the ref-kind on a class
  parameter.

When the pointee is a struct, blittability is checked by the same
`BlittableDetector` used for the by-value struct path (ADR-0093 §2) and
the diagnostic falls through to GS0349 instead — the remediation is
identical (add `@StructLayout(LayoutKind.Sequential)` and confirm every
field is blittable).

The historical GS0326 ("ref/out/in parameter is not supported") path
for ref-kind parameters is retired. GS0326 still fires for the remaining
function-shape constraints (async / generic / instance / extension /
`shared` / ref-return).

Cross-references:

- ADR-0086 — original P/Invoke / `@DllImport` ADR.
- ADR-0092 — `@LibraryImport` source-generator-shaped P/Invoke.
- ADR-0093 — struct and class marshalling.
- ADR-0094 — `ref` / `out` / `in` parameter marshalling (this feature).
- ADR-0060 — `ref` / `out` / `in` parameter and argument syntax.
- Issues #760 (this feature), #727 (original P/Invoke), #758
  (`@LibraryImport`), #759 (struct marshalling), #706 (native-interop
  parent).


## P/Invoke function-pointer marshalling diagnostics (GS0353 – GS0356)

See ADR-0095 (issue #761). G# now supports passing managed callbacks
and raw unmanaged function pointers across the P/Invoke boundary via
two complementary shapes:

* **Shape A — delegate types** annotated with
  `@UnmanagedFunctionPointer(CallingConvention.Cdecl)`. Pass an
  instance of the delegate as a parameter; the runtime synthesizes a
  stable C-ABI thunk and keeps the delegate alive for the duration of
  `Marshal.GetFunctionPointerForDelegate` + the inner native call.
* **Shape B — raw function pointers** spelled
  `unmanaged[Cdecl] (T1, T2, ...) -> R`. Encoded as
  `ELEMENT_TYPE_FNPTR` in the metadata blob; the runtime value is an
  address-sized integer (interconvertible with `nint`).

| ID | Severity | Description |
|----|----------|-------------|
| GS0353 | Error | Delegate-typed P/Invoke parameter `<name>` of type `<T>` requires the delegate declaration to be annotated with `@UnmanagedFunctionPointer(CallingConvention.Cdecl)` (or a matching calling convention). |
| GS0354 | Error | Unknown calling convention `<name>` on an `unmanaged` function-pointer type clause. Use one of: `Cdecl`, `Stdcall`, `Thiscall`, `Fastcall`. |
| GS0355 | Error | Returning a managed delegate `<T>` from a P/Invoke declaration is not supported. Declare the return as `unmanaged[CC] (...) -> R` (a raw function pointer) or `nint` and wrap manually with `Marshal.GetDelegateForFunctionPointer`. |
| GS0356 | Error | Raw function-pointer type clause is missing its calling-convention slot. Expected `unmanaged[Cdecl|Stdcall|Thiscall|Fastcall] (...) -> R`. |

Cause/fix:

- **GS0353 — missing `@UnmanagedFunctionPointer`.** A G# delegate
  passed to a native callback parameter is marshalled through a
  runtime-synthesized thunk that needs an explicit calling
  convention. Add `@UnmanagedFunctionPointer(CallingConvention.Cdecl)`
  on the `type Name = delegate func(...) R` declaration.
- **GS0354 — unknown calling convention.** Only the four CLR-defined
  unmanaged conventions are accepted. `Cdecl` is the right choice for
  almost all libc-style APIs; pick `Stdcall` only for the legacy
  Win32 ABI.
- **GS0355 — delegate-typed return.** The runtime cannot conjure a
  managed wrapper for an arbitrary native function pointer because it
  has no contract for who owns the pointer's lifetime. Switch the
  return to `unmanaged[CC] (...) -> R` for a raw FNPTR, or to `nint`
  if the caller will wrap manually.
- **GS0356 — missing `[CC]` slot.** The `unmanaged` contextual
  keyword always requires an immediate `[Convention]` bracket list.
  This makes the calling convention syntactically explicit at every
  declaration site so the metadata FNPTR signature is unambiguous.

GC lifetime contract (Shape A): the CLR keeps the delegate rooted for
the duration of `Marshal.GetFunctionPointerForDelegate` + the inner
native call. **The caller is responsible for holding an explicit
reference to the delegate for as long as the native side may call
back.** The canonical pattern is to assign the delegate to a local or
field and call `GC.KeepAlive(<delegate>)` at the end of the scope.

Cross-references:

- ADR-0086 — original P/Invoke / `@DllImport` ADR.
- ADR-0092 — `@LibraryImport` source-generator-shaped P/Invoke.
- ADR-0093 — struct and class marshalling.
- ADR-0094 — `ref` / `out` / `in` parameter marshalling.
- ADR-0095 — function-pointer marshalling (this feature).
- Issues #761 (this feature), #706 (native-interop parent).


## P/Invoke `@MarshalAs` parameter override diagnostics (GS0357 – GS0360)

See ADR-0096 (issue #762). G# now honours `@MarshalAs(UnmanagedType.…)`
on a P/Invoke parameter (`@DllImport` or `@LibraryImport`), emitting a
CLR `FieldMarshal` table row per ECMA-335 II.23.4 so the runtime
marshaller picks up the explicit override at the unmanaged boundary.
The v1 supported `UnmanagedType` set is: `LPStr`, `LPWStr`,
`LPUTF8Str`, `BStr`, `LPArray`, `SafeArray`, `I1`, `U1`, `I2`, `U2`,
`I4`, `U4`, `I8`, `U8`, `Bool`, `VariantBool`, `SysInt`, `SysUInt`,
`Struct`, `ByValTStr`, `ByValArray`. Anything else (`CustomMarshaler`,
`IUnknown`, `IDispatch`, `FunctionPtr`, `Currency`, `LPStruct`) is
rejected.

| ID | Severity | Description |
|----|----------|-------------|
| GS0357 | Error | `@MarshalAs` UnmanagedType `<value>` is not in the v1 supported set. Use one of: `LPStr`, `LPWStr`, `LPUTF8Str`, `BStr`, `LPArray`, `SafeArray`, `I1`, `U1`, `I2`, `U2`, `I4`, `U4`, `I8`, `U8`, `Bool`, `VariantBool`, `SysInt`, `SysUInt`, `Struct`, `ByValTStr`, `ByValArray`. |
| GS0358 | Error | `@MarshalAs(UnmanagedType.<X>)` is not valid on parameter `<name>` of type `<T>`. The per-UnmanagedType type-compatibility table (ADR-0096 §3) defines which G# types each marshaller accepts. |
| GS0359 | Error | `@MarshalAs(UnmanagedType.<X>)` on parameter `<name>` requires the `<arg>` named argument. `ByValTStr` and `ByValArray` require `SizeConst:`; `LPArray` requires `SizeConst:` and/or `SizeParamIndex:`. |
| GS0360 | Error | `@MarshalAs` on parameter `<name>` is not supported: `<reason>`. Two reasons fire today — the enclosing function is not a P/Invoke declaration, or the parameter is a `string` on a `@LibraryImport`. |

Cause/fix:

- **GS0357 — unsupported UnmanagedType.** Pick a value from the v1
  supported set above. `CustomMarshaler` and `IUnknown`-style COM
  interop are deliberately deferred; raw function pointers already
  have first-class syntax (`unmanaged[CC] (...) -> R`, ADR-0095).
- **GS0358 — type mismatch.** Each `UnmanagedType` only accepts a
  narrow set of G# parameter types — strings for `LPStr` /
  `LPWStr` / `LPUTF8Str` / `BStr` / `ByValTStr`; integers (or
  `bool` / `char`) for `I1`…`U8`; slices for `LPArray` /
  `SafeArray` / `ByValArray`; struct values for `Struct`. Either
  change the parameter type to match the marshaller, or drop the
  `@MarshalAs` and let the default ADR-0086 marshalling rule apply.
- **GS0359 — missing required knob.** Inline / sized forms need a
  compile-time element count. `ByValTStr(SizeConst: N)`,
  `ByValArray(SizeConst: N)`, `LPArray(SizeConst: N)` or
  `LPArray(SizeParamIndex: i)`.
- **GS0360 — rejected combination.** `@MarshalAs` has no meaning on
  a managed (non-P/Invoke) function — the runtime never reads
  `FieldMarshal` rows for managed methods. On `@LibraryImport`
  string parameters, the function-wide `StringMarshalling:` knob is
  the only lever — `@LibraryImport(StringMarshalling:
  StringMarshalling.Utf8)` (or `Utf16`) replaces a per-parameter
  `@MarshalAs(UnmanagedType.LPUTF8Str)` / `LPWStr`.

Pseudo-custom attribute (ADR-0096 §5): `@MarshalAs` is encoded
exclusively as a `FieldMarshal` table row + the `HasFieldMarshal`
flag on the Param row. The emitter does *not* also write a
`CustomAttribute` row for it — this matches C#'s `[MarshalAs]`
treatment and keeps the metadata byte-for-byte interoperable with
`ildasm`, ILSpy, and decompilers.

Cross-references:

- ADR-0086 — original P/Invoke / `@DllImport` ADR.
- ADR-0092 — `@LibraryImport` source-generator-shaped P/Invoke.
- ADR-0093 — struct and class marshalling.
- ADR-0094 — `ref` / `out` / `in` parameter marshalling.
- ADR-0095 — function-pointer marshalling.
- ADR-0096 — `@MarshalAs` parameter overrides (this feature).
- Issues #762 (this feature), #706 (native-interop parent).

## Type-parameter `class` / `struct` / `new()` constraint diagnostic (GS0361)

ADR-0097 / issue #775. The new bracket-position flag-style
constraints (`[T class]`, `[T struct]`, `[T new()]`, plus combinations
like `[T class new()]` and `[T IFoo class]`) compose freely with each
other and with the legacy single-slot `any` / `comparable` /
sealed-interface bound — except for two combinations that are rejected
as mutually exclusive:

| Code | Severity | Message |
|----|----------|-------------|
| GS0361 | Error | Type parameter `<T>` carries the mutually exclusive constraints `<first>` and `<second>`. The two combinations that fire today are `class struct` (a type cannot simultaneously be a reference type and a value type) and `struct new()` (the `new()` flag is redundant because the CLR's `NotNullableValueTypeConstraint` already implies `DefaultConstructorConstraint` per ECMA-335 II.10.1.7). |

Cause/fix:

- **`class struct` combo.** Pick one. Reference-type-only callers want
  `[T class]`; value-type-only callers want `[T struct]`. If you really
  want "any type", drop both and use `[T]` (or `[T any]`).
- **`struct new()` combo.** Drop the explicit `new()` — `struct`
  already requires every type argument to expose a public parameterless
  constructor at the CLR level. The emitter sets both flag bits
  whenever it sees `struct`, so the explicit `new()` adds nothing.

Cross-references:

- ADR-0097 — G# spelling for `class` / `struct` / `new()` constraints.
- ADR-0088 — constraint-aware overload resolution (the consumption side
  that reads CLR `GenericParameterAttributes` from imported types).
- ADR-0084 — Gsharp.Extensions Optional/Sequences (the canonical use
  case for disjoint `class` vs `struct` overloads).
- Issues #775 (this feature), #706 (Oats cleanup parent), #724
  (Extensions stdlib parent).

## Target-typed bare `default` literal diagnostic (GS0362)

ADR-0100 / issue #795. The bare `default` literal (without an
accompanying `(T)` type clause) takes its type from the surrounding
target-typed position: the initializer of `let`/`var` with an explicit
type clause, the value of `return` when the enclosing function has a
known return type, an argument to a parameter of known type, and a
conditional branch typed by its sibling. When no target type is
available, GS0362 fires.

| Code | Severity | Message |
|----|----------|-------------|
| GS0362 | Error | The bare `default` literal can only be used where its type is known from context. Use `default(T)` to spell the default value of an explicit type. |

Cause/fix:

- **`var x = default` with no type clause and no initializer-typed sibling.** Either add a type clause (`var x int32 = default`) or use the typed form (`var x = default(int32)`).
- **`Console.WriteLine(default)` against an overloaded method.** Pick the overload by writing `default(T)`, where `T` matches the parameter type you want, or assign the value to a typed local first.
- **`return default` from a function whose return type cannot be inferred.** Annotate the function's return type, or use `return default(T)` directly.

Cross-references:

- ADR-0100 — `default(T)` and target-typed bare `default` expression.
- ADR-0081 — `nil` literal (the source-level spelling for reference null; `default(T)` for a reference-type `T` is equivalent to `nil`).
- ADR-0087 — reified generics (`initobj T` for unconstrained `T`).
- Issues #795 (this feature), #792 (dogfooded `Optional`/`Sequences` port), #706 (parent tracker).

## Variadic-parameter diagnostics (GS0363, GS0364, GS0365)

ADR-0101 (`...T` parameters) and ADR-0102 (variadic slot in anonymous
function-type clauses) / issues #799, #818. The canonical G# spelling
for a variadic parameter is `name ...T` (Go-style: the ellipsis sits
between the parameter identifier and the element type); inside the
body the parameter has type `[]T`. A signature may declare **at most
one** variadic parameter and it must be the **last** parameter
(see `GS0145` above). Variadic declarations are accepted on top-level
`func` declarations and on anonymous function-type clauses of the
shape `(T1, ...T2) -> R`; other declaration sites report `GS0146`
(see above).

| Code | Severity | Message |
|----|----------|-------------|
| GS0363 | Error | The C# `params` keyword is not supported in G#. Use the canonical variadic spelling `name ...T` (Go-style); inside the function body the parameter has type `[]T`. |
| GS0364 | Error | A function signature may declare at most one variadic parameter. |
| GS0365 | Error | A variadic parameter slot in an anonymous function-type clause must use the slice form `[]T`; got `<typeName>`. |

Cause/fix:

- **GS0363 — `params` keyword.** Replace `params values []T` with `values ...T`. The lowering and call-site behaviour are identical; this is purely a spelling decision (ADR-0101 §"Structural rules" explains why the alias was rejected).
- **GS0364 — multiple variadic parameters.** Pick the one parameter that should accept the parameter pack and drop the `...` from the others. The remaining variadic must be the last parameter (`GS0145`).
- **GS0365 — variadic slot in `(...)-> R` is not a slice.** In an
  anonymous function-type clause the `...` marker turns the parameter
  slot into a pack/passthrough call site, so the slot's element type
  must be a slice. Spell it `(...[]T) -> R`, not `(...T) -> R`. The
  body-side spelling on a real declaration (`func f(values ...T)`) is
  unchanged.

Caller-side semantics — the binder packs trailing positional arguments
into a fresh `[]T` array; if the caller supplies exactly one trailing
`[]T` argument (after generic substitution), it is forwarded
unwrapped, preserving array identity. The emitted MethodDef carries
`[System.ParamArrayAttribute]` on the variadic parameter so C# / F# /
VB consumers see it as `params T[]`.

Cross-references:

- ADR-0101 — variadic (`...T`) parameter declarations.
- ADR-0102 — variadic slot in anonymous function-type clauses.
- ADR-0084 — slice type `[]T` (the body-visible type of a variadic parameter).
- ADR-0063 — overload resolution & generic inference.
- Issues #799, #818 (these features), #792 (dogfooded `Optional`/`Sequences` port), #706 (parent tracker).


## Map type-clause spelling removal (GS0366)

ADR-0104 / issue #805. The legacy Go-flavored map type-clause spelling
`map[K]V` (key inside the brackets, value outside) has been **removed**
in v0.2. The canonical G# spelling is `map[K,V]` with both type
arguments inside the brackets, separated by a comma — the same
single-bracket / comma-separated shape every other multi-argument type
clause already uses (`Foo[T1, T2]`, `Dictionary[K, V]`,
`func(P1, P2) R`, `(K, V)` tuple). There is no deprecation window;
the parser emits `GS0366` and the program does not compile.

| Code | Severity | Message |
|----|----------|-------------|
| GS0366 | Error | The `map[K]V` type-clause spelling has been removed; use `map[{key},{value}]` instead (ADR-0104). |

Cause/fix:

- Replace every type-clause occurrence of `map[K]V` with `map[K,V]`.
  The migration is purely syntactic — symbol identity, binding,
  lowering, and emit are unaffected, and the runtime backing type
  remains `System.Collections.Generic.Dictionary<K, V>`.

```diff
- var m = map[string]int32{"a": 1}
+ var m = map[string,int32]{"a": 1}

- func makeIndex() map[string]Person { … }
+ func makeIndex() map[string,Person] { … }

- func (self map[K]V) CountKeys() int32 { … }
+ func (self map[K,V]) CountKeys() int32 { … }
```

Map index/use sites are unchanged — only the **type-clause** spelling
moves. `m["a"]`, `len(m)`, `delete(m, k)`, and the map literal entry
form `{k: v, …}` are all unaffected.

The parser still recognises the legacy shape long enough to emit a
span-accurate diagnostic that quotes the exact replacement, so IDE
quick-fixes can patch the whole construct in one edit. Mixed-form
files produce one `GS0366` per legacy occurrence with **no cascade
errors** — the parser binds the recovered shape to the same
`MapTypeSymbol` so downstream binding proceeds unchanged.

Cross-references:

- ADR-0104 — map type clause canonical spelling.
- ADR-0020 — Go-style `[T]` generic type-parameter brackets.
- ADR-0040 — `sequence[T]` (the other contextual-keyword type clause).
- Issues #805 (this change), #706 (parent tracker).


