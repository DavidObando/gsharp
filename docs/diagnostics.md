# GSharp Diagnostic Reference

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
| GS0106 | Error | `inline` cannot be combined with `data` or `record`. | `inline data struct Foo { … }` is not legal. |
| GS0107 | Error | `inline struct` cannot be combined with `open`. | `open inline struct Foo { … }` is not legal. |
| GS0108 | Error | Inline struct synthesised member conflicts with an explicit declaration. | An `inline struct` auto-generates certain member names that cannot be re-declared. |
| GS0109 | Error | `record` is an alias for `data struct` and cannot be combined with `data`. | `data record Foo { … }` — use either `data struct` or `record`. |
| GS0110 | Error | Empty enum declaration. | `type Color enum {}` — an enum must have at least one member. |
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
| GS0160 | Error | Ambiguous overload. | A call that matches more than one overload equally well. |
| GS0161 | Error | `copy`/`with` receiver is not a `data struct`. | `.copy(…)` used on a plain `struct`. |
| GS0162 | Error | Named arguments only supported for `data struct` `.copy(…)`. | Named arguments passed to a regular function. |
| GS0163 | Error | Deconstruction field count mismatch. | `a, b := p` where `p` is a `data struct` with three fields. |
| GS0164 | Error | Deconstruction requires a tuple or `data struct` initializer. | Deconstruction attempted on a plain `struct`. |
| GS0165 | Error | Top-level statements may appear in at most one package per compilation. | Two or more `package` declarations in a single compilation each contain top-level statements (see [ADR-0066](adr/0066-top-level-statement-mechanics.md)). |
| GS0166 | Warning | Top-level statements conflict with an explicit `Main` function. | Both top-level statements and a `func Main()` are present; TLS wins, the explicit `Main` is shadowed (see [ADR-0066](adr/0066-top-level-statement-mechanics.md) §4). |
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
| GS0186 | Error | Interface method may not have a body. | A method declared inside an `interface` has an implementation block. |
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
| GS0203 | Error | Class tagged `@Attribute` cannot also declare an explicit base class. | `@Attribute type Trace class : Other {}` — the `@Attribute` sugar implies `: System.Attribute`. |
| GS0204 | **Warning** (Error if `IsError=true`) | Reference to a symbol marked `[Obsolete]`. | Calling a function, instantiating a class (`Old(5)`), writing a struct literal (`Old{}`), naming a struct/class/interface/enum in a type clause, reading an obsolete parameter, reading/writing an obsolete `var`/`let`/`const`, reading an obsolete enum member (`Color.Red`), or reading/writing an obsolete struct/class field (`p.Old`) — all declared with `@Obsolete("use Bar")`. Severity is promoted to error when the attribute's second argument is `true`. |
| GS0205 | Error | Attribute is reserved for compiler synthesis. | `@CompilerGenerated`, `@Extension`, `@AsyncStateMachine`, `@Nullable`, or `@NullableContext` written in user source. |
| GS0206 | Error | Annotations are only allowed on variable declarations, not on this statement. | `@Obsolete\nreturn` inside a function body — annotations may precede `var`/`let`/`const` but no other statement kind. |
| GS0207 | Error | Parameter `{name}` is annotated `@EnumeratorCancellation` but has type `{type}`; only `System.Threading.CancellationToken` parameters can carry this annotation. | `@EnumeratorCancellation` placed on a `string` parameter. |
| GS0208 | Error | Parameter `{name}` is annotated `@EnumeratorCancellation` but its enclosing function is not an async sequence (does not return `IAsyncEnumerable[T]`). | `@EnumeratorCancellation` on a sync function or a non-sequence async function. |
| GS0209 | Error | Attribute `{name}` is not valid on this position; its `[AttributeUsage]` permits only: `{targets}`. | Applying a `@field`-targeted attribute to a method. |
| GS0210 | Error | Duplicate attribute `{name}`; this attribute type does not allow multiple applications (`AllowMultiple = false`). | Two `@Trace(...)` annotations on the same declaration. |
| GS0211 | Error | Attribute `[DllImport]` is recognised but not supported in v1.0; P/Invoke (extern function bodies) is a post-v1.0 feature. | `@DllImport("user32.dll") func MessageBox() {}` — emit support and the `extern` body marker arrive after v1.0. |
| GS0212 | Error | Function `{name}` is marked `@Conditional` but does not return `void`; conditional methods must return `void` because calls may be elided at the call site. | `@Conditional("DEBUG") func Probe() int32 { return 0 }`. |

### Class / constructor diagnostics (GS0213–GS0217)

Issue #306 covers user class constructor flow — explicit `init(...)` constructors, primary constructors, and `base(...)` initializers.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0213 | Error | A base-constructor argument list requires an explicit base class. | `init() : base(1) { }` written on a class with no `: BaseType` clause. |
| GS0214 | Error | Class `{base}` has no accessible constructor that takes `{N}` argument(s). | `init() : base(1, 2)` when the base only declares `init()`. |
| GS0215 | Error | Class `{name}` cannot declare both a primary constructor and an explicit `init` constructor. | `type Customer class(id int32) { init(name string) { } }`. |
| GS0216 | Error | Class `{name}` declares multiple `init` constructors; only a single explicit constructor is supported. | Two `init(...)` declarations in the same class body. |
| GS0217 | Error | Generic class `{name}` with an explicit `init` constructor cannot be constructed; generic explicit constructors are not supported. | `type Box[T] class { init(x T) { } }` then `Box[int32](42)`. |

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
type Window ref struct {
    var Items ReadOnlySpan[int32]   // a ref struct may hold by-ref-like fields
    var Label string
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

## String escape diagnostics (GS0269)

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0269 | Error | Unrecognised escape sequence `\X` in string literal. | `"\q"` — `\q` is not a valid escape. Use `\\` for a literal backslash. |

## Async disposable diagnostics (GS0271–GS0272)

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0271 | Error | `await using let` outside an async function. | `func f() { await using let x = ... }` — `await using let` requires `async func`. |
| GS0272 | Error | Type is not async-disposable. | `await using let x = Foo()` where `Foo` provides no public `DisposeAsync()` method returning `ValueTask`. |

## If-expression diagnostics (GS0276–GS0277)

See [ADR-0064](adr/0064-if-expression-and-block-expression.md). `if` used as a value-producing expression (`let x = if cond { a } else { b }`) requires both branches to produce a value of a common type. The diagnostics below guard the two binder rejection paths that are unique to the expression form; the branch-type-mismatch case reuses GS0263 (shared with the ADR-0062 ternary).

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0276 | Error | An if-expression in value position must have an `else` branch so that all code paths produce a value. | `let x = if cond { 1 }` — the if has no `else`, so when `cond` is false there is no value to bind. Add a terminal `else { … }`, or use the statement form (`if cond { x = 1 }`). Applies to chained `else if` shapes too: every chain must end in a terminal `else`. |
| GS0277 | Error | A block in an if-expression value position must end with a value-producing expression. | `let x = if cond { } else { 1 }` — the then-block is empty. Replace the empty block with `{ <expr> }`, or fall through with an explicit value (`{ 0 }`). Also fires when the block's last statement is a non-expression form (`for`, `while`, etc.) and there is no trailing expression to lift out. |

## Top-level statement diagnostics (GS0285–GS0287)

These complement the existing top-level statement diagnostics in the main table (GS0165 multi-package, GS0166 conflict-with-Main) and round out ADR-0066's contract. See [ADR-0066](adr/0066-top-level-statement-mechanics.md) for the full rule set.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0285 | Error | Top-level statements are not allowed in a library project. | A `.gsproj` with `<OutputType>Library</OutputType>` whose `.gs` source contains statements at the file root. Set `<OutputType>Exe</OutputType>` or move the statements into an explicit `func Main()`. Mirrors C# CS8805 (ADR-0066 §10 / D4). |
| GS0286 | Warning | Top-level statements should form a single contiguous block within a file. | A `.gs` file that interleaves declarations between top-level statements, e.g. `var x = 1; func helper() {}; var y = 2`. Both the C# style (TLS first, then decls) and the Go style (decls first, then TLS) are accepted; only interleaved layouts trigger the warning (ADR-0066 §11 / D5). |
| GS0287 | Error | Top-level statements mix bare `return;` and `return <expr>;`. | TLS that contains both `return` (no value) and `return 0` — the synthesized `<Main>$` must have a single return type, so choose one shape (ADR-0066 §8 / D2). |

## Field declaration diagnostics (GS0288)

See [ADR-0067](adr/0067-fields-require-var-keyword.md). Field declarations inside class/struct bodies must use `var` or `let`.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0288 | Error | Field declarations require a `var` (mutable) or `let` (read-only) keyword. | `type Point struct { X int32 }` — must be written as `var X int32` (mutable) or `let X int32` (read-only). |

## Class destructor diagnostics (GS0289–GS0292)

See [ADR-0068](adr/0068-deinit-destructor-support.md). The Swift-style `deinit { … }` form on a class is the source-level analog of a C# `~Type()` finalizer. Each diagnostic in this block guards the surface against shapes the destructor cannot legally have.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0289 | Error | `deinit` is only valid on class types (not structs, ref-structs, interfaces, or enums). | `type Point struct { var X int32 deinit { … } }` — value types do not have finalizers in the CLR. |
| GS0290 | Error | Only one `deinit` declaration is allowed per class. | A class body that declares `deinit { … }` twice — the C# finalizer surface only supports a single `~Type()` per type. |
| GS0291 | Error | `deinit` may not declare parameters. | `deinit(x int32) { … }` — a CLR finalizer is parameter-less. |
| GS0292 | Error | `deinit` may not declare a return type. | `deinit int32 { … }` — a CLR finalizer is `void`. |

## Null-coalescing compound assignment diagnostics (GS0298–GS0299)

See ADR-0072. `??=` (`a ??= b`) writes `b` into `a` only when the current value of `a` is `nil`. The diagnostics below guard the two binder rejection paths for misuse of the operator.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0298 | Error | The left-hand side of `??=` must be of nullable type. | `var s = "hi"; s ??= "x"` — `s` has type `string` (non-nullable), so the operator can never fire. Either declare `s string?` or use a plain `=`. |
| GS0299 | Error | The left-hand side of `??=` must be assignable: a variable, parameter, field, property, or indexer. | `compute() ??= "v"` — the result of a method call is not an lvalue. Store the value first and `??=` into the variable. |

A read-only lvalue (`let x string? = nil; x ??= "v"`) reports the existing `GS0127` for parity with the simple assignment path.

## Arrow lambda and switch-arm `:` diagnostics (GS0302)

See [ADR-0074](adr/0074-arrow-lambda-and-colon-switch-arms.md). The lambda operator is now `->`; switch-expression arms separate pattern from result with `:`. The pre-existing `->` form on switch arms still parses for one release with a warning.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0302 | Warning | `'->' in a switch-expression arm is deprecated; use ':' instead (ADR-0074).` | `case 0 -> "zero"` — rewrite as `case 0: "zero"`. |

## Arrow function-type clause diagnostics (GS0303)

See [ADR-0075](adr/0075-arrow-function-type-clause.md). The canonical function-type clause is `(T1, T2, ...) -> R`; the legacy `func(T) R` spelling continues to parse for one release with a warning.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0303 | Warning | `'func(...)' function-type clauses are deprecated; use '(T) -> R' instead (ADR-0075).` | `var f func(int32) int32 = …` — rewrite as `var f (int32) -> int32 = …`. Async variant: `async func(T) R` → `async (T) -> R`. |

GS0303 fires once per occurrence of the legacy `func` keyword in a *type-clause* position. It does **not** fire on function *declarations* (`func name(...) R { … }`), function *literals* (`func(...) R { … }` expressions), or `delegate func(...)` named-delegate type declarations — all three keep `func`.

## Lambda binding type-inference diagnostics (GS0304)

See [ADR-0076](adr/0076-lambda-binding-type-inference.md). When a `let` / `var` binding has neither an explicit function-type clause nor a lambda initializer whose parameter types are all spelled, the binder has no way to resolve the binding's type.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0304 | Error | `Cannot infer the type of '<name>' from a lambda with untyped parameters; supply a function-type clause on the binding or annotate the lambda parameters (ADR-0076).` | `let f = (x) -> x + 1` — fix by spelling either side, e.g. `let f = (x int32) -> x + 1` or `let f (int32) -> int32 = (x) -> x + 1`. |

GS0304 fires only when *both* sides of the binding are open. If the binding spells the function type, parameter types may be omitted on the lambda (the existing target-typing path). If the lambda's parameters are fully typed, the binding's type is inferred to the lambda's `(T1, ...) -> R` signature with the return type computed bottom-up from the body (single-expression: the expression's type; block body: the common type of every value-producing return path; if no `return` produces a value, `void`). Generic method calls that receive a lambda argument (`xs.Where(x -> x > 0)`) still go through the method-type-inference path and are unaffected.

## Internal compiler error diagnostics (GS9998–GS9999)

| ID | Severity | Description |
|----|----------|-------------|
| GS9998 | Error | Internal compiler error (emit-time failure). The emit pipeline encountered an unexpected state and could not produce valid IL. The diagnostic message includes the exception type and a brief description of the failure. |
| GS9999 | Error | Fatal I/O error. An unrecoverable file-system error occurred (permission denied, disk full, etc.) before or during assembly writing. |

`GS9998` is the *silent emit failure* diagnostic. It is always anchored at the user's source file at the location of the expression or statement that triggered the failure. If you ever see `GS9998` anchored at `(1,1,1,1)` against `gsc.dll` instead of your source file, that itself is a bug — please file an issue.

The message format is `<ExceptionType>: <description>`, for example `InvalidOperationException: Variable 'x' has no local slot`. This tells you what the compiler was trying to do when it failed, even though the underlying bug may not be your fault.

Suppressing or `WarnAsError`-ing `GS9998` follows the same MSBuild plumbing as any other diagnostic (`/nowarn:GS9998` or `<NoWarn>GS9998</NoWarn>`), though suppressing it is not recommended since it masks genuine compiler bugs.
