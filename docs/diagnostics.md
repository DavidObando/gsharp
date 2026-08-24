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

> **`GS####` vs `GSA####`.** The `GS####`/`CS2GS####` identifiers in this
> document are emitted by `gsc`/`cs2gs` about **user** G# code. They are
> distinct from the internal `GSA####` Roslyn analyzers that police the
> compiler's own C# source (field-token resolution, imported-type identity,
> reflection-cache lifetime). Those are a build-time developer gate on this
> repository, not user-facing language diagnostics — see
> [internal-analyzers.md](./internal-analyzers.md).

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

> **Enum exhaustiveness.** Enum switches cover named constants only.
> `[Flags]` does not add unnamed bit combinations as required switch arms.
> This rule is identical for imported CLR enums and source-declared enums.
> If a switch expression receives a value that matches no arm, compiled and interpreted execution fail with `Unmatched switch expression value.` instead of producing a default value.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0100 | Error | Not all code paths return a value. | A non-void function is missing a `return` on some branch. |
| GS0101 | Error | Parameter already declared. | Two parameters share the same name. |
| GS0102 | Error | Symbol already declared. | A variable or function name is used twice in the same scope. |
| GS0103 | Error | Method receiver must be a struct or class declared in the same package. | Receiver type is a built-in or external type. |
| GS0104 | Error | Reserved; not currently emitted. Zero-field `data class`/`data struct` declarations are supported with trivial equality/hash/ToString/copy semantics and no synthesized `Deconstruct`. | — |
| GS0105 | Error | `inline struct` requires exactly one field. | `inline struct Foo { a int; b int }` has two fields. |
| GS0106 | Error | `inline` cannot be combined with `data`. | `inline data struct Foo { … }` is not legal. (Historical: the `record` keyword was removed by; pre-removal this diagnostic also covered `inline record`.) |
| GS0107 | Error | `inline struct` cannot be combined with `open`. | `open inline struct Foo { … }` is not legal. |
| GS0108 | Error | Inline struct synthesised member conflicts with an explicit declaration. | An `inline struct` auto-generates certain member names that cannot be re-declared. |
| GS0109 | Error | `record` was an alias for `data struct` and could not be combined with `data`. GS0307 replaces this on legacy sources. | `data record Foo { … }` — use `data struct Foo` or `data class Foo`. |
| GS0110 | Error | Empty enum declaration. | `enum Color {}` — an enum must have at least one member. |
| GS0111 | Error | Duplicate enum member. | Two members in the same `enum` share a name. |
| GS0112 | Error | Undefined enum member. | `Color.Purple` where `Purple` is not a declared member of `Color`. |
| GS0113 | Error | Undefined type. | A type name referenced in code does not exist. |
| GS0114 | Error | Invalid array length. | Array length must be a non-negative integer literal. |
| GS0115 | Error | Array literal length mismatch. | `[3]int{1, 2}` — literal has 2 elements but length is 3. |
| GS0116 | Error | Type is not indexable. | `x[0]` where `x` is `bool` or another type with no array/slice/map element access and no CLR indexer. Arrays, slices, maps, CLR indexers, and `Span[T]` / `ReadOnlySpan[T]` are all indexable. |
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
| GS0153 | Error | Constraint is neither an interface nor a class. | A generic type-parameter constraint must be an interface (any interface — sealed or not, generic or not;) or a base class; a value type such as a struct or enum is rejected. |
| GS0154 | Error | Wrong argument type. | A free, instance, extension, or shared call argument has no permitted conversion to its parameter type. |
| GS0155 | Error | Cannot convert type. | Outside call-argument matching, no built-in or user-defined conversion exists; use a compatible value or an API that performs the transformation (for example, `Parse`/`TryParse` for text). |
| GS0156 | Error | Cannot convert implicitly; explicit conversion exists. | `var x int32 = 3.14` — write `var x int32 = int32(3.14)` to apply the available explicit conversion. |
| GS0157 | Error | Cannot find type (possibly missing import). | A package-qualified type name that resolves to nothing. |
| GS0158 | Error | Cannot find member. | A field or property access that does not resolve. |
| GS0159 | Error | Cannot resolve function call. | A function name does not resolve, or its nullable receiver lacks valid non-null narrowing. |
| GS0160 | Error | Ambiguous overload. | A call that matches more than one overload equally well. Generic candidates are filtered against their `where`-constraints; the constraint-disjoint case usually resolves to one candidate, but two candidates with mutually-incomparable constraint specificity remain ambiguous and report this code. |
| GS0161 | Error | `copy`/`with` receiver is not a `data struct`. | `.copy(…)` used on a plain `struct`. |
| GS0162 | Error | Named arguments only supported for `data struct` `.copy(…)`. | Named arguments passed to a regular function. |
| GS0163 | Error | Deconstruction field count mismatch. | `let (a, b) = p` where `p` is a `data struct` with three fields. |
| GS0164 | Error | Deconstruction requires a tuple, `data struct`, or accessible `Deconstruct` method. | Deconstruction attempted on a type without a supported deconstruction shape. |
| GS0165 | Error | Top-level statements may appear in at most one package per compilation. | Two or more `package` declarations in a single compilation each contain top-level statements. |
| GS0166 | Warning | Top-level statements conflict with an explicit `Main` function. | Both top-level statements and a `func Main()` are present; TLS wins and the explicit `Main` is shadowed. |
| GS0167 | Error | Multi-assignment target/value count mismatch. | `a, b = 1, 2, 3` — three values for two targets. |
| GS0168 | Error | `fallthrough` must be the last statement of a `switch` case body. | `fallthrough` followed by more statements in the same case body (issue #3501 A3: a trailing `fallthrough` is now legal Go-style control flow). |
| GS0169 | Error | Duplicate `default` arm in `switch`. | Two `default:` arms inside one `switch` statement. |
| GS0170 | Error | Switch case value is not a constant expression. | `case x:` where `x` is a mutable variable. |
| GS0171 | Error | Switch case type is incompatible with the switch expression. | `switch (s) { case 42: }` where `s` is `string`. |
| GS0172 | Error | Property pattern requires a struct or class value. | A property pattern `{ Field: value }` applied to a non-struct/class type. |
| GS0173 | Error | Undefined field on type. | Accessing a struct field that was never declared. |
| GS0174 | Error | Relational pattern operator not defined for type. | `case > 5:` where the switched type doesn't support `>`. |
| GS0175 | Error | List pattern requires an array or slice. | List pattern `[a, b]` applied to a non-array/slice value. |
| GS0176 | Error | Switch expression is missing a `default` arm. | A `switch` expression that cannot be proven exhaustive and has no `default`. |
| GS0177 | Error | Switch expression on enum is not exhaustive. | One or more named enum constants not covered and no `default` arm. |
| GS0178 | Error | Switch statement on enum is not exhaustive. | One or more named enum constants not covered and no `default` arm. |
| GS0179 | Error | Switch expression arm type mismatch. | Different arms of a `switch` expression produce incompatible types. |
| GS0180 | Error | Accessibility modifier not allowed here. | `pub` or `priv` used on a local variable or inside a function body. |
| GS0181 | Error | Base class is not open. | Inheriting from a class that was not declared `open`. |
| GS0182 | Error | Method is overridable; `override` required. | Redefining an `open` method without the `override` keyword. |
| GS0183 | Error | No matching open base method for `override`. | `override` keyword present but no base class defines a matching open method. |
| GS0184 | Error | Cannot override a non-open base method. | `override` targets a method that was not declared `open`. |
| GS0185 | Error | Override signature mismatch. | An `override` method has different parameter types or return type than the base. |
| GS0186 | Error | _(historical — removed)_ Interface method may not have a body. | Default-interface methods are now supported (see GS0318–GS0321). |
| GS0187 | Error | Class or struct does not implement interface method. | A class or struct claims to implement an interface but a required method is absent. |
| GS0188 | Error | Class or struct cannot implement a sealed interface from a different package. | A class or struct implements a `sealed interface` defined outside its package. |
| GS0189 | Error | The return type of an `async func(...)` type clause is implicitly wrapped in `Task`; do not write `Task[…]` explicitly. | `async func(int) Task[int]` in a type position. |

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
| GS0211 | Error | _(repurposed)_ Attribute `[DllImport]` was historically rejected wholesale; well-formed `@DllImport`-annotated P/Invoke declarations are now accepted (see GS0322–GS0329 for shape-specific diagnostics). The slot is reserved for any future blanket-rejection use. | n/a — no longer fired. |
| GS0212 | Error | Function `{name}` is marked `@Conditional` but does not return `void`; conditional methods must return `void` because calls may be elided at the call site. | `@Conditional("DEBUG") func Probe() int32 { return 0 }`. |

### Class / constructor diagnostics (GS0213–GS0217)

Issue #306 covers user class constructor flow — explicit `init(...)` constructors, primary constructors, and `base(...)` initializers.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0213 | Error | A base-constructor argument list requires an explicit base class. | `init() : base(1) { }` written on a class with no `: BaseType` clause. |
| GS0214 | Error | Class `{base}` has no accessible constructor that takes `{N}` argument(s). | `init() : base(1, 2)` when the base only declares `init()`. |
| GS0215 | Error | Class `{name}` cannot declare both a primary constructor and an explicit `init` constructor. | `class Customer(id int32) { init(name string) { } }`. |
| GS0216 | Error | Class `{name}` declares multiple `init` constructors; only a single explicit constructor is supported. | Two `init(...)` declarations in the same class body. |
| GS0217 | _Retired_ | Previously: generic class with an explicit `init` constructor cannot be constructed. Generic classes with explicit `init(...)` constructors are now supported; this diagnostic is no longer emitted. | — |

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

Issue #1655: the ref-kind-on-async/iterator ban was previously misfiled under this ID; it now ships as **GS0422** — see [Reassigned diagnostics (GS0419–GS0424)](#reassigned-diagnostics-gs0419gs0424).

### Nested-type resolution diagnostics (GS0268)

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0268 | Error | Type does not contain a nested type of the requested name. | `Outer.Missing` when `Outer` exists but declares no nested type named `Missing`. |

### Reassigned diagnostics (GS0419–GS0424)

Issue #1655: the IDs below used to collide with earlier, unrelated diagnostics (GS0189, GS0190, GS0226, GS0241, GS0268 respectively). Each collision has been resolved by keeping the earliest-established meaning on the original ID and moving the newer, unrelated meaning to a fresh ID.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0419 | Reserved | Former auto-property-in-`data struct` diagnostic; auto-properties are now supported in data aggregates. | Reserved for compatibility. |
| GS0420 | Error | The argument to `nameof` must be a name reference: an identifier, member access, or type. | `nameof(123)` or `nameof(Console.WriteLine("hi"))`. Previously misfiled under GS0190. |
| GS0421 | Error | Member is marked `open` but the enclosing class is not open. | `class C { open func M() {} }` where `C` is not declared `open`. Previously misfiled under GS0190. |
| GS0422 | Error | A ref-kind parameter (`ref`/`out`/`in`) cannot appear on an `async`, `sequence`, or `async sequence` function. | `async func f(ref x int32) { }` — the state-machine rewriter cannot hoist a managed pointer into a field. Previously misfiled under GS0226. |
| GS0423 | Error | Type does not implement a usable `GetEnumerator()` method and cannot be iterated with `for ... in`. | `for x in 42 { }` where `42`'s type has no usable `GetEnumerator()`. Previously misfiled under GS0268. |
| GS0424 | Error | A ref-kind modifier (`ref`/`out`/`in`) is not legal on a primary-constructor parameter. | `class Vec(ref x int32) { }` — primary-constructor parameters materialize fields, and the CLR cannot store a managed pointer in a field. Previously misfiled under GS0241. |

### Pointer / by-ref diagnostics (GS9001–GS9008)

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS9001 | Error | Cannot take the address of a non-lvalue. | `&(1 + 2)` — the operand is a temporary expression. |
| GS9002 | Error | Argument must be passed by `ref`. | A `ref` parameter called without the `ref` modifier. |
| GS9003 | Error | Variable not definitely assigned before `ref` use. | `ref x` where `x` has not been assigned. |
| GS9004 | Error | By-ref value cannot escape its declaration scope. | Returning a `*T` (managed-pointer) value from a function, capturing a `*T` local in a closure, hoisting a `*T` local into an `async`/iterator state machine, or using a `*T` return type in a function literal. Also raised when returning a `ref struct` parameter annotated as `scoped`. |
| GS9005 | Error | Cannot take the address of a constant. | `&myConst` where `myConst` is declared `const`. |
| GS9006 | Error | Pointer type cannot be a field type. | A struct or class field (including static `shared` fields and top-level globals) declared with a `*T` (managed-pointer) type **outside an `unsafe` context**. Inside an `unsafe` context `*T` is an unmanaged pointer and IS legal as a field type. |
| GS9007 | Error | A type may contain at most one `shared` block. | A class or struct with two `shared { ... }` blocks; merge them into one. |
| GS9008 | Error | A pointer bound by `fixed` cannot be captured by a closure because the closure may outlive the pin. | A lambda inside `fixed p *int32 = xs` captures `p`. |

### Reference closure diagnostics (GS9100)

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS9100 | **Warning** | One or more assemblies supplied via `/r:` depend (transitively) on assemblies that were not also supplied, so the reference set is not a complete transitive closure. The compiler degrades gracefully — members whose signatures live in the missing assemblies are skipped rather than aborting the build — but the affected members become invisible. The message names the missing assemblies. Add the missing package/project reference (the SDK passes `@(ReferencePathWithRefAssemblies)`, MSBuild's full transitive closure, so this normally only appears with a hand-rolled `/r:` set). Suppress with `/nowarn:GS9100`. | `gsc /r:LibAsmA.dll app.gs` where `LibAsmA.dll` references `DepAsmB.dll` and `DepAsmB.dll` is not also passed. |

### Analyzer host diagnostics (GS9300–GS9319, reserved)

The GS9300–GS9319 block is reserved for the G# analyzer framework host
([ADR-0169](adr/0169-gsharp-analyzer-framework.md)): `gsc` loading and running
`GSharpDiagnosticAnalyzer` assemblies passed via `/gsanalyzer:`. (The adjacent
GS92xx block belongs to the gsgen source-generator host.)

| ID | Severity | Description |
|----|----------|-------------|
| GS9300 | Warning | An analyzer threw an exception; it is disabled for the remainder of the compilation. The message names the analyzer type and the exception. |
| GS9301 | Error | An analyzer assembly passed via `/gsanalyzer:` failed to load or contains no analyzers. |
| GS9302 | Info | An analyzer exceeded its time budget in an interactive host and was disabled for subsequent runs. |
| GS9303 | Warning | An analyzer was built against a different `GSharp.Core` version than the host; the load is attempted anyway. |
| GS9304 | Warning | An analyzer reported a diagnostic whose ID is not declared in its `SupportedDiagnostics`; the diagnostic is suppressed. |

### Internal diagnostics (GS9996–GS9999)

These diagnostics indicate a fatal compiler or runtime execution failure. If you encounter them, please file an issue.

| ID | Severity | Description |
|----|----------|-------------|
| GS9996 | Error | Source generator execution failure. `gsc` could not locate or launch `gsgen`, `gsgen` timed out, or it exited nonzero without producing its own diagnostics. |
| GS9997 | Error | Fatal compiler I/O error. An unrecoverable file-system error occurred (permission denied, disk full, etc.) before or during assembly writing. |
| GS9998 | Error | Internal compiler error (emit-time failure). The emit pipeline encountered an unexpected state and could not produce valid IL. The diagnostic message includes the exception type and a brief description of the failure. |
| GS9999 | Error | Historical: an unexpected exception caught by the tree-walking evaluator. No product driver produces it; the emitted test oracle synthesizes it as the assertion surface for uncaught runtime exceptions. |

#### Interpreter compiled-only boundaries (retired)

[ADR-0153](adr/0153-interpreter-compiled-only-storage-boundary.md) defined
storage-dependent unsafe constructs as compiled-only in the tree evaluator
(`GS0513` for unmanaged `&`/`*`, plus legacy `GS9999` guards tracked by
[#3199](https://github.com/DavidObando/gsharp/issues/3199)). The evaluator —
and with it the boundary and its diagnostics — was deleted in
[ADR-0156](adr/0156-gsi-emit-to-memory-execution.md) Phase 3c: every driver
executes emitted code, where these constructs run natively.

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

## Named delegate type diagnostics (GS0233)

Issue #3510 (originally ADR-0059 / issue #255): `delegate Name(params) ReturnType;` declares a real CLR `MulticastDelegate`-derived named delegate type so C# consumers see a conventional handler type (and so G# events can carry first-class custom delegate types). GS0233 now fires only on the retired `type Name = delegate …` recovery path when `func` is missing. Issue #1503 lifted the v1 restriction on generic delegate declarations: `type Predicate[T any] = delegate func(value T) bool` now binds and emits a verifiable generic delegate `TypeDef` (one `GenericParam` row per type parameter, threaded through the `Invoke`/`.ctor` signatures), so GS0234 is no longer reported and has been retired.

| Code | Severity | Message |
|------|----------|---------|
| GS0233 | Error | Named delegate declaration requires 'func(...)' after 'delegate' (retired `type Name = delegate …` recovery form only; the canonical spelling is `delegate Name(params) ReturnType;` — see GS0535 / issue #3510). |

## Ref-kind parameter diagnostics (GS0235–GS0243)

ADR-0060 introduces explicit `ref`, `out`, and `in` parameter passing modes at both call sites and method-definition sites. The ADR (§8) originally enumerated diagnostics GS0230–GS0238, but those codes were already in use by ADR-0029 / ADR-0030 / ADR-0056 / ADR-0059; the ADR-0060 diagnostics ship at the next free range, GS0235–GS0243, with a 1:1 mapping (GS0230→GS0235, GS0231→GS0236, …, GS0238→GS0243). The async/iterator ban (§10) is reported as **GS0422** and the primary-constructor ban (ADR-0060 + ADR-0029) as **GS0424** — see [Reassigned diagnostics (GS0419–GS0424)](#reassigned-diagnostics-gs0419gs0424).

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
| GS0259 | Error (retired) | Conditional lvalue expression (`cond ? a : b`) is only legal as the payload of a 'ref'/'out'/'in' argument modifier or as the operand of '&'. Now only fires for the legacy inner-ref-modifier shape outside ref context. |
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
- **GS0265** — a default-value expression that is not constant, a parameter whose default depends on another parameter, an optional parameter preceding a required one without all trailing parameters also optional, or an optional ref/out parameter. Fix: use a compile-time-constant default, place optional parameters at the end of the list, and avoid combining `ref`/`out` with defaults. A value-type `default(T)` (and the zero-value `T()` form) is accepted and materializes the type's all-zero value at omitted call sites, matching C#.
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

## `null` identifier "did you mean nil?" diagnostic (GS0273)

See [ADR-0081](adr/0081-null-identifier-did-you-mean-nil.md). `null` is not a keyword in G#; the canonical null literal is `nil` (ADR-0001). When the identifier `null` is used in a value-expression position and no symbol named `null` is in scope, the binder emits `GS0273` and recovers by synthesising a `nil` literal so target-type contexts continue to typecheck. The diagnostic is suppressed when a symbol named `null` (variable, function, field) is in scope — those declarations remain legal and identifier resolution wins over the recovery.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0273 | Error | `'null' is not a literal in G#. Did you mean 'nil'?` | `let x string? = null` — replace `null` with `nil`. Also fires for `Foo(null)` where `Foo` takes `T?`, `x == null`, and inside lambda bodies. Does not fire when `null` resolves to a real symbol in scope. |

## If-expression diagnostics (GS0276–GS0277)

See [ADR-0064](adr/0064-if-expression-and-block-expression.md). `if` used as a value-producing expression (`let x = if cond { a } else { b }`) requires both branches to produce a value of a common type. The diagnostics below guard the two binder rejection paths that are unique to the expression form; the branch-type-mismatch case reuses GS0263 (shared with the ADR-0062 ternary).

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0276 | Error | An if-expression in value position must have an `else` branch so that all code paths produce a value. | `let x = if cond { 1 }` — the if has no `else`, so when `cond` is false there is no value to bind. Add a terminal `else { … }`, or use the statement form (`if cond { x = 1 }`). Applies to chained `else if` shapes too: every chain must end in a terminal `else`. |
| GS0277 | Error | A block expression in value position must end with a value-producing expression. | `let x = { let y = 1 }` or `let x = if cond { } else { 1 }`. Add a trailing value (`{ let y = 1 y }`). Also fires when the last item is a non-expression form (`for`, `while`, etc.). |

Both codes apply verbatim to the ADR-0151 [`if let` expression](adr/0151-if-let-expressions.md) (`let x = if let v = maybe { v } else { fallback }`), as does GS0263 for non-unifying branch tails; a non-nullable binding initializer additionally reports GS0296.

## Top-level statement diagnostics (GS0285–GS0287)

These complement the existing top-level statement diagnostics in the main table (GS0165 multi-package, GS0166 conflict-with-Main) and round out ADR-0066's contract. See [ADR-0066](adr/0066-top-level-statement-mechanics.md) for the full rule set.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0285 | Error | Top-level statements are not allowed in a library project. | A `.gsproj` with `<OutputType>Library</OutputType>` whose `.gs` source contains statements at the file root. Set `<OutputType>Exe</OutputType>` or move the statements into an explicit `func Main()`. Mirrors C# CS8805. |
| GS0286 | Warning | Top-level statements should form a single contiguous block within a file. | A `.gs` file that interleaves declarations between top-level statements, e.g. `var x = 1; func helper() {}; var y = 2`. Both the C# style (TLS first, then decls) and the Go style (decls first, then TLS) are accepted; only interleaved layouts trigger the warning. |
| GS0287 | Error | Top-level statements mix bare `return;` and `return <expr>;`. | TLS that contains both `return` (no value) and `return 0` — the synthesized `<Main>$` must have a single return type, so choose one shape. |

## Field declaration diagnostics (GS0288)

See [ADR-0067](adr/0067-fields-require-var-keyword.md). Field declarations inside class/struct bodies must use `var` or `let`.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0288 | Error | Field declarations require a `var` (mutable), `let` (read-only), or `const` (compile-time constant) keyword. | `struct Point { X int32 }` — must be written as `var X int32` (mutable), `let X int32` (read-only), or `const X int32 = …` (constant). |

## Class destructor diagnostics (GS0289–GS0292)

See [ADR-0068](adr/0068-deinit-destructor-support.md). The Swift-style `deinit { … }` form on a class is the source-level analog of a C# `~Type()` finalizer. Each diagnostic in this block guards the surface against shapes the destructor cannot legally have.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0289 | Error | `deinit` is only valid on class types (not structs, ref-structs, interfaces, or enums). | `struct Point { var X int32 deinit { … } }` — value types do not have finalizers in the CLR. |
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
| GS0302 | Warning | `'->' in a switch-expression arm is deprecated; use ':' instead.` | `case 0 -> "zero"` — rewrite as `case 0: "zero"`. |

## Arrow function-type clause diagnostics (GS0303)

See [ADR-0075](adr/0075-arrow-function-type-clause.md). The canonical function-type clause is `(T1, T2, ...) -> R`; the legacy `func(T) R` spelling continues to parse for one release with a warning. The managed function-pointer form `*func(T) R` is a distinct ADR-0122 construct and is not deprecated.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0303 | Warning | `'func(...)' as a type clause is deprecated; use the arrow form '(...) -> R' instead. The managed function-pointer form '*func(...) R' is a distinct construct and is not deprecated.` | `var f func(int32) int32 = …` — rewrite as `var f (int32) -> int32 = …`. Async variant: `async func(T) R` → `async (T) -> R`. |

GS0303 fires once per occurrence of the legacy `func` keyword in a *type-clause* position. It does **not** fire on function *declarations* (`func name(...) R { … }`), function *literals* (`func(...) R { … }` expressions), `delegate func(...)` named-delegate type declarations, or `*func(...) R` managed function-pointer types — all four keep `func`. Rewriting a function pointer as `*((...) -> R)` changes its meaning to a pointer to a managed delegate and produces GS0398.

## Lambda binding type-inference diagnostics (GS0304)

See [ADR-0076](adr/0076-lambda-binding-type-inference.md). When a `let` / `var` binding has neither an explicit function-type clause nor a lambda initializer whose parameter types are all spelled, the binder has no way to resolve the binding's type.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0304 | Error | `Cannot infer the type of '<name>' from a lambda with untyped parameters; supply a function-type clause on the binding or annotate the lambda parameters.` | `let f = (x) -> x + 1` — fix by spelling either side, e.g. `let f = (x int32) -> x + 1` or `let f (int32) -> int32 = (x) -> x + 1`. |

GS0304 fires only when *both* sides of the binding are open. If the binding spells the function type, parameter types may be omitted on the lambda (the existing target-typing path). If the lambda's parameters are fully typed, the binding's type is inferred to the lambda's `(T1, ...) -> R` signature with the return type computed bottom-up from the body (single-expression: the expression's type; block body: the common type of every value-producing return path; if no `return` produces a value, `void`). Generic method calls that receive a lambda argument (`xs.Where(x -> x > 0)`) still go through the method-type-inference path and are unaffected.

## `:=` short variable declaration removal (GS0305)

See [ADR-0077](adr/0077-drop-colon-equals-short-variable-declaration.md). The Go-style `:=` short variable declaration was removed from the language; every binding site requires `let` (immutable) or `var` (mutable). The lexer keeps tokenising `:=` as `ColonEqualsToken` so the parser can emit a span-accurate diagnostic with a context-sensitive migration suggestion instead of cascading parse errors.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0305 | Error | `':=' short variable declaration has been removed; use 'let' (immutable) or 'var' (mutable) instead (e.g. '<migration>').` | `x := 1` → `let x = 1` (or `var x = 1`). `for i := 0 ... 10` → `for i in 0 ... 10`. `for v := range xs` → `for v in xs`. `for k, v := range dict` → `for k, v in dict`. `await for x := range seq` → `await for x in seq`. `case v := <-ch` → `case let v = <-ch`. `for i := 0; i < n; i++` → `for var i = 0; i < n; i++`. `if x := init; cond` → `if var x = init; cond`. |

GS0305 fires at every parse position that previously accepted `:=` — statement scope, multi-target assignment, `for` and `await for` range and ellipsis loops, `for` / `if` simple-statement initialisers, and `select` case bindings — and recovers by synthesising the corresponding canonical token (`=` for declarations / multi-target assignment, `in` for the for-range and for-ellipsis and await-for-range forms) so subsequent binding, lowering, and emit see a well-formed tree and no cascade diagnostics fire on the same statement. The diagnostic's `Location` covers the `:=` token itself.

## Owned-receiver method warning (GS0314)

See [ADR-0079](adr/0079-restrict-receiver-clauses-to-non-owned-types.md). The Go-style receiver-clause method form (`func (r T) M() { ... }`) is now reserved for types this package does **not** own — imported CLR types, BCL primitives, and types declared by referenced packages. Owned-type instance methods should be declared inside the type body. The warning fires once per declaration, at the receiver-type location. Operator overloads (`func (a T) operator +(b T) T`) are exempt because operators have no in-body form today.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0314 | Warning | `Receiver-clause methods are reserved for types this package does not own; declare '<MethodName>' as a member of '<TypeName>' instead.` | `class Point { var X int32 } func (p Point) Distance() int32 { ... }` — `Point` is owned by the current package; move `Distance` into the class body. Cross-package and CLR receivers (`func (sb StringBuilder) Reset() ...`) are unaffected. |

GS0314 is a soft warning during a one-release grace period; a future ADR may escalate it to an error. Suppress per-project via `<NoWarn>GS0314</NoWarn>` if migration must be deferred.

## Named-argument `=` separator retired (GS0524)

See [ADR-0161](adr/0161-retire-equals-named-argument-separator.md), which supersedes
[ADR-0080](adr/0080-deprecate-equals-named-arguments.md). Named arguments are written
`name: value` (issue #343). The legacy `name = value` spelling — deprecated by ADR-0080 with the
one-release `GS0315` warning — is **retired**: `=` after an identifier in argument position is no
longer a separator and parses as an ordinary assignment expression, exactly as `=` does in every
other expression position. `GS0315` no longer exists.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0524 | Warning | `Argument '<name> = …' is an assignment to '<name>', not a named argument — the '=' named-argument separator was retired. Write '<name>: value' for a named argument, or '(<name> = value)' to assign deliberately.` | `Foo(timeout = 30)` — write `Foo(timeout: 30)` for a named argument, or `Foo((timeout = 30))` to assign. |

The warning exists because the two readings can differ **silently**: where `name` is both an
assignable variable in scope and a parameter of the callee, the old spelling now assigns and passes
the value positionally instead of binding by name. Where `name` is not in scope, the change is a
loud binder error (`GS0125`) instead.

Only a **bare** assignment argument warns. Parenthesising (`Foo((timeout = 30))`) states the
assignment intent unambiguously and is warning-free — it is the spelling cs2gs emits for a
value-position assignment. Parameter default values (`func f(x int32 = 0)`) and `with`-expression
field initializers (`p with { x = 10 }`) parse on separate paths and are unaffected.

## Pattern binding in boolean `is` expression (GS0525)

| ID | Severity | Summary | Example |
| --- | --- | --- | --- |
| GS0525 | Error | A boolean `is` pattern uses the switch binding spelling `name is Type`, which reads as an incoherent double test in expression position. Write the designation after the type (`is Type name`, ADR-0166) to introduce a pattern variable, or use `if let` / `guard let` / `while let`. | `if value is text is string { }` |

## Invalid multi-assignment target (GS0526)

| ID | Severity | Summary | Example |
| --- | --- | --- | --- |
| GS0526 | Error | A multi-assignment target is not writable storage. Use a variable, field, property, array element, indexer, or pointer dereference. | `GetValue(), x = 1, 2` |

## Rectangular arrays (GS0527–GS0530)

| ID | Severity | Message | Example |
|---|---|---|---|
| GS0527 | Error | `Rectangular array rank is <rank>, but <count> index expression(s) were supplied.` | `let a = [2, 3]int32; let x = a[0]` |
| GS0528 | Error | `Rectangular array rank <rank> exceeds CLR maximum rank 32.` | A type or allocation with 33 dimensions. |
| GS0529 | Error | `Rectangular array initializer dimensions must be non-negative int32 constants.` | `let n = 2; let a = [n, 2]int32{1, 2, 3, 4}` |
| GS0530 | Error | `Rectangular array initializer requires <expected> element(s), but <actual> were supplied.` | `let a = [2, 3]int32{1, 2, 3}` |

## Constructor initializer instance access (GS0531)

| ID | Severity | Message | Example |
|---|---|---|---|
| GS0531 | Error | `Constructor initializer arguments cannot reference instance member '<name>' before the delegated or base constructor has run.` | `init() : base({ let self = this 1 }) { }` |

## `fallthrough` placement (GS0533–GS0534)

Issue #3501 A3: `fallthrough` gained Go semantics — legal only as the LAST
statement of a non-final `switch` arm, transferring into the next arm's body
without evaluating its pattern or guard. GS0168 (above) reports a misplaced
`fallthrough`; these report the two structural misuses.

| ID | Severity | Message | Example |
|---|---|---|---|
| GS0533 | Error | `'fallthrough' cannot be used in the final arm of a 'switch' statement.` | `switch x { case 1 { fallthrough } }` |
| GS0534 | Error | `'fallthrough' cannot target a 'switch' arm whose pattern declares bindings or that has a 'when' guard — the jump would skip their assignment.` | `case 1 { fallthrough } case string s { ... }` |

## Retired delegate-declaration spelling (GS0535)

Issue #3510: named delegates are declared with the standalone
`delegate Name(parameters) ReturnType;` form (trailing semicolon required —
it terminates the optional return-type clause the way extern natives and
interface bodiless members do, so a void delegate can no longer consume the
declaration that follows it). The ADR-0059 `type Name = delegate func(...)`
spelling reports this error and recovers, and `type` itself is no longer a
reserved keyword (erased aliases `type Name = Target` parse contextually).

| ID | Severity | Message | Example |
|---|---|---|---|
| GS0535 | Error | `The 'type <Name> = delegate func(...)' spelling is retired. Declare the delegate as 'delegate <Name>(parameters) ReturnType;' (trailing semicolon required; omit the return type for void).` | `type Greeter = delegate func(name string)` |

## Pattern variable outside its definitely-assigned region (GS0532)

[ADR-0166](adr/0166-is-pattern-variables.md): a designation in a boolean `is`
pattern (`value is string text`, `value is { Length: > 0 } text`,
`values is [..rest]`) introduces a read-only pattern variable that is in scope
exactly where C# would consider it definitely assigned — the right operand of
`&&` (or of `||` after a negated test), the branches selected by the
condition, the loop body, the guarded switch arm, and the statements after an
`if` whose other branch always exits. Reading it anywhere else is a
definite-assignment error rather than an unknown name.

| ID | Severity | Message | Example |
|---|---|---|---|
| GS0532 | Error | `Pattern variable '<name>' is not definitely assigned here; it is only usable where its pattern is known to have matched — the right operand of '&&' (or of '\|\|' after a negated test), the branches selected by the condition, and the statements after an 'if' whose other branch always exits (ADR-0166, issue #3409).` | `if value is string s { }` followed by `s.Length`; `value is string s \|\| s.Length > 0` |

## Default-interface-method diagnostics (GS0318–GS0321)

See [ADR-0085](adr/0085-default-interface-methods-implementation.md) (which supersedes the deferral in ADR-0018). Interfaces may now expose default-method bodies; classes that implement the interface inherit the default unless they declare their own override. The four diagnostics below cover the conflict, dropped-default, missing-implementer, and deferred-modifier cases.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0318 | Error | `<Kind> '<C>' inherits conflicting default implementations of '<Name>' from interfaces '<IA>' and '<IB>'. Declare '<C>.<Name>' explicitly to disambiguate.` | Two unrelated interfaces both supply a default body for the same signature; the class or struct fails to override. |
| GS0319 | Error | `<Kind> '<C>' relied on a default implementation of '<I>.<Name>' that was removed. Declare an explicit override on '<C>'.` | Reserved for a class or struct that relied on a removed default-interface implementation. |
| GS0320 | Error | `<Kind> '<C>' does not implement interface method '<I>.<Name>' and the interface does not provide a default.` | Replaces the historical GS0187 path when a class or struct omits a method that has no default. |
| GS0321 | Error | `Modifier '<modifier>' on interface method '<Name>' is not yet supported; 'open', 'override', and 'sealed override' interface members are deferred.` | Fires when an interface method body carries a deferred modifier such as `open`, `override`, or `sealed override` — the parser accepts the shape so the binder can report a precise diagnostic. `private` is supported and no longer fires GS0321. `static` is not a modifier on interface methods; static-virtual members are declared inside the interface's `shared { … }` block. |
| GS0368 | Error | `Interface method '<Name>' has no body and must be terminated with ';'; a bodyless 'func' uses ';' as its no-body marker, mirroring P/Invoke.` | A body-less interface method (abstract instance method, or an abstract static slot inside the interface's `shared { … }` block) must end with `;`. A method with a `{ … }` body takes no `;`. |

The historical `GS0186` ("Interface method may not have a body.") is no longer emitted; ADR-0085 explicitly unblocks default-interface methods. The diagnostic code is retained as a reserved slot for backwards compatibility but the binder no longer fires it.

## P/Invoke diagnostics (GS0322–GS0329)

ADR-0086 / issue #727 introduces `@DllImport`-annotated function declarations whose body is a single `;` token (no managed body). The compiler emits CLR `PinvokeImpl` metadata for these declarations. The following diagnostics flag malformed P/Invoke shapes — every check is performed by `PInvokeBinder`, and an unannotated `;` body is rejected by GS0325. The historical blanket-rejection at GS0211 no longer fires.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0322 | Error | `@DllImport` requires a non-empty library name as its first positional argument. | `@DllImport func F() int32;` — missing the library name. |
| GS0323 | Error | P/Invoke parameter or return type `{type}` is not in the supported marshalling table. | `@DllImport("libc") func F(o Object) int32;` — `Object` is not marshallable in v1. |
| GS0324 | Error | Function `{name}` is annotated `@DllImport` but has a managed body; P/Invoke declarations must use a `;` body. | `@DllImport("libc") func F() int32 { return 0 }`. |
| GS0325 | Error | Function `{name}` has no body; only `@DllImport`-annotated functions may use a `;` body marker. | `func F() int32;` without a preceding `@DllImport`. |
| GS0326 | Error | `@DllImport` is not supported on this function shape (`{reason}`). | `@DllImport("libc") async func F() int32;` — async functions, generic functions, instance/extension methods, `shared` members, and ref-returning functions are all disallowed in v1. |
| GS0327 | Error | `@DllImport` `CharSet` value `{value}` is not recognised; valid values are `CharSet.Ansi`, `CharSet.Unicode`, `CharSet.Auto`, and `CharSet.None`. | `@DllImport("libc", CharSet: "Utf8")`. |
| GS0328 | Error | `@DllImport` `CallingConvention` value `{value}` is not recognised; valid values are `CallingConvention.Winapi`, `Cdecl`, `StdCall`, `ThisCall`, and `FastCall`. | `@DllImport("libc", CallingConvention: "MyCall")`. |
| GS0329 | Error | `@DllImport` `EntryPoint` must be a non-empty string. | `@DllImport("libc", EntryPoint: "")`. |

See ADR-0086 for the complete attribute-knob table, supported marshalling types, and a worked example.

## `@LibraryImport` P/Invoke diagnostics (GS0342–GS0344)

ADR-0092 / issue #758 adds the modern source-generator-shaped `@LibraryImport`
attribute. The compiler emits an explicit managed marshalling stub that calls
a hidden blittable inner P/Invoke, so the runtime never auto-marshals at the
unmanaged boundary. The attribute reuses the body-shape, library-name, and
unsupported-type checks above (GS0322–GS0329); the codes below cover the
surface unique to `@LibraryImport`.

| ID | Severity | Description |
|----|----------|-------------|
| GS0342 | Error | Function `{name}` is annotated with both `@DllImport` and `@LibraryImport`; choose one. |
| GS0343 | Error | `StringMarshalling` value `{value}` is not a valid `StringMarshalling` member; use `Utf8` or `Utf16`. |
| GS0344 | Error | `@LibraryImport` function `{name}` has a `string` surface (parameter or return) and must specify `StringMarshalling: StringMarshalling.Utf8` or `StringMarshalling.Utf16`. |

`string` return types are supported (issue #1504): the inner P/Invoke returns
the raw native pointer and the outer stub materializes the managed string via
`Marshal.PtrToStringUTF8`/`PtrToStringUni`. The returned native buffer is
treated as non-owning (it is not freed). The retired GS0345 code (which used to
reject a `string` return) is no longer emitted and is not reused.

See ADR-0092 for the full design rationale.

## Struct / class P/Invoke marshalling diagnostics (GS0346–GS0351)

ADR-0093 / issue #759 adds `@StructLayout(LayoutKind.…)` on `struct` / `class`
declarations and `@FieldOffset(N)` on the fields of `Explicit`-layout types.
Both are CLR *pseudo-custom attributes* — the runtime reconstructs them at
reflection time from the `ClassLayout` / `FieldLayout` metadata-table rows,
so the emitter writes those rows directly and skips the normal
`CustomAttribute` encoding.

| ID | Severity | Description |
|----|----------|-------------|
| GS0346 | Error | `@StructLayout(LayoutKind.{value})` is not supported; v1 accepts only `LayoutKind.Sequential` and `LayoutKind.Explicit`. `LayoutKind.Auto` is rejected because the CLR may reorder fields, breaking ABI. |
| GS0347 | Error | Field `{field}` of explicit-layout struct `{type}` is missing a `@FieldOffset(N)` annotation; every field of an `Explicit`-layout type must carry one. |
| GS0348 | Error | `@FieldOffset` on field `{field}` of `{type}` is only valid inside an `Explicit`-layout type; declare `@StructLayout(LayoutKind.Explicit)` on the enclosing struct or drop the annotation. |
| GS0349 | Error | Type `{type}` is not blittable and cannot appear in a P/Invoke signature without per-field `@MarshalAs` (deferred); rewrite the type to use blittable fields only. |
| GS0350 | Error | `@FieldOffset({value})` value is not a valid non-negative `int32`. |
| GS0351 | Error | Class `{type}` cannot be used as the return type of a P/Invoke function; return a struct or `nint` instead. |

See ADR-0093 for the full blittability rules, interaction with ADR-0086 /
ADR-0092, and the class-by-reference policy.

## P/Invoke `ref` / `out` / `in` parameter diagnostic (GS0352)

ADR-0094 / issue #760 lifts the v1 blanket rejection of `ref`/`out`/`in`
parameters on a P/Invoke declaration (the old GS0326 path) and routes
unsupported pointee types through the tailored GS0352 diagnostic. The
rule is "the pointee must be blittable": blittable primitives
(`int8`…`int64`, `nint`/`nuint`, `float32`/`float64`) and
`@StructLayout`-annotated structs are accepted; `bool`, `char`,
`string`, `object`, decimal, slices, sequences, classes, and nullable
value types are rejected.

| ID | Severity | Description |
|----|----------|-------------|
| GS0352 | Error | `'ref'/'out'/'in'` parameter `<name>` requires a blittable pointee; `<T>` is not blittable. Use a blittable primitive (`int8`…`int64`, `nint`/`nuint`, `float32`/`float64`), or a struct annotated with `@StructLayout(LayoutKind.Sequential)`. |

The struct-pointee path continues to use GS0349 (same remediation as the
by-value struct case). GS0326 still fires for the remaining function-shape
constraints (async / generic / instance / extension / `shared` / ref-return).
See ADR-0094 for the full pointee table and worked examples.

## P/Invoke `@MarshalAs` parameter override diagnostics (GS0357 – GS0360)

ADR-0096 / issue #762 adds per-parameter `@MarshalAs(UnmanagedType.…)`
overrides on `@DllImport` and `@LibraryImport` declarations. The
binder validates each annotation against a strict UnmanagedType /
parameter-type compatibility table; mis-use surfaces through four
dedicated diagnostics so a malformed `@MarshalAs` never reaches the
emitter.

| ID | Severity | Description |
|----|----------|-------------|
| GS0357 | Error | `@MarshalAs` UnmanagedType `{value}` is not in the v1 supported set. Supported values: `LPStr`, `LPWStr`, `LPUTF8Str`, `BStr`, `LPArray`, `SafeArray`, `I1`, `U1`, `I2`, `U2`, `I4`, `U4`, `I8`, `U8`, `Bool`, `VariantBool`, `SysInt`, `SysUInt`, `Struct`, `ByValTStr`, `ByValArray`. |
| GS0358 | Error | `@MarshalAs(UnmanagedType.{X})` is not valid on parameter `{name}` of type `{T}`. The per-UnmanagedType type-compatibility table defines which G# types each marshaller accepts. |
| GS0359 | Error | `@MarshalAs(UnmanagedType.{X})` on parameter `{name}` requires the `{arg}` named argument. `ByValTStr` and `ByValArray` require `SizeConst:`; `LPArray` requires `SizeConst:` and/or `SizeParamIndex:`. |
| GS0360 | Error | `@MarshalAs` on parameter `{name}` is not supported: `{reason}`. Two reasons fire today — the enclosing function is not a P/Invoke declaration, or the parameter is a `string` on a `@LibraryImport` (use the function-wide `StringMarshalling:` knob instead). |

See ADR-0096 for the full UnmanagedType / G#-type compatibility table,
the ECMA-335 II.23.4 FieldMarshal blob encoding for each accepted form,
and the interaction with ADR-0086 (`@DllImport`), ADR-0092
(`@LibraryImport`), ADR-0093 (struct marshalling), ADR-0094 (ref/out/in),
and ADR-0095 (function pointers).

## Inline field initializer diagnostics (GS0375–GS0377)

Issue #948 added inline `const`/`let`/`var` field initializers (`= expr` on a
field declaration in a type body). The following diagnostics enforce their
constraints.

| ID | Severity | Summary |
| --- | --- | --- |
| GS0375 | Error | A `const` field requires an initializer (e.g. `const X int32 = 10`). |
| GS0376 | Error | A `const` field initializer must be a compile-time constant expression. |
| GS0377 | Error | A field initializer cannot reference the instance member or constructor parameter `{name}` (field initializers run before the constructor body, so `this` is not available). Assign it in an `init(...)` constructor instead. |

## Self-inheritance diagnostic (GS0378)

Issue #949: a class may name itself as a generic type *argument* in its own
base/implements clause (the common `class Shape : IEquatable[Shape]` pattern is
legal). However, naming itself directly as its own base class is an illegal
self-inheritance cycle and is reported here.

| ID | Severity | Summary |
| --- | --- | --- |
| GS0378 | Error | Class `{name}` cannot inherit from itself (e.g. `class A : A` or the generic `class A[T] : A[T]`). Naming the enclosing type merely as a type argument of a base/interface type — `class Shape : IEquatable[Shape]` — is legal.  | |

## Struct base-clause diagnostic (GS0382)

Issue #976: a `struct` (CLR value type) may declare an implemented-interface
clause (`struct Money : IEquatable[Money] { … }`), mirroring a `class`. Because
every value type always derives from `System.ValueType`, a struct's clause may
list **interfaces only** — naming a class or another struct as a base type is
rejected here.

| ID | Severity | Summary |
| --- | --- | --- |
| GS0382 | Error | Struct `{structName}` cannot declare base type `{baseTypeName}`; a struct may only implement interfaces.  | |

## Abstract member diagnostics (GS0386–GS0388)

Issue #987: a no-body `open func F() R;` inside an `open class` is the
canonical G# spelling of a C# `abstract` method. The declaring type is
abstract (emitted with `TypeAttributes.Abstract`) and cannot be instantiated;
a concrete (non-`open`) subclass must override every inherited abstract member.

| ID | Severity | Summary |
| --- | --- | --- |
| GS0386 | Error | Cannot create an instance of the abstract type `{typeName}`. |
| GS0387 | Error | `{className}` does not implement inherited abstract member `{declaringType}.{member}`. |
| GS0388 | Error | Abstract method `{methodName}` must be declared `open` inside an `open class`; `{className}` is not open or the method omits `open`. |

## `init()` constraint construction diagnostic (GS0389)

Issue #988: a type parameter that carries an `init()` default-constructor
constraint (`[T init()]`) may be constructed inside the generic body with the
call-like spelling `T()`. The construction lowers to a reified
`System.Activator.CreateInstance<T>()` (ADR-0087), which works for both
reference types with a public parameterless constructor and value types.
(The constraint keyword was renamed from `new()` to `init()` by issue #997.)

| ID | Severity | Summary |
| --- | --- | --- |
| GS0389 | Error | `Cannot construct '<T>()' because type parameter '<T>' has no 'init()' constraint; add an 'init()' constraint (e.g. '[<T> init()]') to allow construction.` |

GS0389 fires when the body constructs a type parameter (`T()`) that does not
declare an `init()` constraint. A type **argument** that cannot satisfy the
`init()` constraint at the instantiation site is reported separately as GS0152.
Mirrors C# CS0304.

## `and`/`or`/`not` pattern combinator diagnostic (GS0390)

Issue #992: switch patterns may be combined with the contextual keywords `and`,
`or`, and `not` (precedence: `not` > `and` > `or`; parentheses override). A type
pattern that introduces a binding variable (`<ident> is T`) is not allowed under
an `or` or `not` combinator, because the variable would not be definitely
assigned when the arm runs (mirrors C# CS8780).

| ID | Severity | Summary |
| --- | --- | --- |
| GS0390 | Error | `A pattern variable ('<name>') may not be declared under an 'or' or 'not' pattern; it would not be definitely assigned. Use '_' instead.` |

GS0390 fires when a binding type pattern appears under `or`/`not`. Use the
discard `_` (e.g. `_ is Dog or _ is Cat`) or move the binding under `and` (or to
the top level), where it is definitely assigned.

## Interface base-clause diagnostic (GS0391)

Issue #1006: an interface may extend one or more base interfaces via a `: A, B`
clause (mirroring C# `interface B : A`). Every entry in the clause must resolve
to an interface — a G# interface or an imported CLR interface. Naming a class or
struct as a base type is rejected.

| ID | Severity | Summary |
| --- | --- | --- |
| GS0391 | Error | `Interface '<interfaceName>' cannot declare base type '<baseTypeName>'; an interface may only extend other interfaces.` |

GS0391 fires when an interface's base clause names a class or struct. Remove the
offending entry (an interface may only extend interfaces).

## User-defined conversion operator diagnostics (GS0393–GS0395)

| ID | Severity | Summary |
| --- | --- | --- |
| GS0393 | Error | `A user-defined '<implicit/explicit>' conversion operator must take exactly one by-value parameter (the source operand).` |
| GS0394 | Error | `A user-defined conversion operator must convert to or from a user type declared in the same package, and its source and target types must differ.` |
| GS0395 | Error | `Duplicate user-defined conversion operator: a conversion from '<source>' to '<target>' is already declared on this type.` |

These fire on conversion operators declared with `func operator implicit (x T) U`
or `func operator explicit (x T) U` (issue #1017). `GS0393` requires exactly one
parameter; `GS0394` requires that at least one of the source or target type is an
owned struct and that the two types differ; `GS0395` rejects a second conversion
(implicit or explicit) with the same source/target pair.

## Standalone range from-end marker diagnostic (GS0410)

| ID | Severity | Description |
|----|----------|-------------|
| GS0410 | Error | A from-end index marker `^` is only valid inside index brackets (e.g. `arr[^1]` or `arr[a..^b]`) or after `..` in a standalone range upper bound (`a..^b`); a standalone range cannot start with `^`. Use an indexer, or parenthesise a one's-complement bound (`(^a)..b`).  | |

GS0410 fires for the standalone range/slice value added in issue #1038
(`let r = 1..3`). The lower bound of a standalone range may not begin with `^`,
because a leading `^` is genuinely ambiguous with the one's-complement unary
operator (`^a` parses as `~a`). The from-end marker is therefore restricted to
the unambiguous positions: inside index brackets (the #1022 path —
`arr[^1]`, `arr[^2..]`, `arr[a..^b]`) and the upper bound of a standalone range
(`..^b`, `a..^b`). To slice from the end of a value, index it directly
(`arr[^a..]`); to use a one's-complement value as a from-start lower bound,
parenthesise it (`(^a)..b`).

## Stackalloc initializer diagnostics (GS0411–GS0412)

| ID | Severity | Description | Example trigger |
|----|----------|------------------------------|-----------------|
| GS0411 | Error | A count-inferred `stackalloc []T` requires an initializer. | A count-inferred `stackalloc []T` written without a brace-delimited initializer, so its length is undeterminable (e.g. `stackalloc []int32`). Supply an initializer (`stackalloc []int32{1, 2, 3}`) or spell the count explicitly (`stackalloc [n]T`). |
| GS0412 | Error | A `stackalloc [n]T{…}` initializer length must match the explicit count. | A `stackalloc [n]T{…}` whose explicit constant count `n` disagrees with the number of initializer elements (e.g. `stackalloc [2]int32{1, 2, 3}`). As in C#, the two must match; use the count-inferred `stackalloc []T{…}` to avoid repeating the length. |

GS0411 and GS0412 cover the `stackalloc [n]T` initializer forms added in issue
#1041 (G#-style array grammar, ADR-0124 / issue #1057). The count-inferred
shape `stackalloc []T{…}` takes its length from the initializer, so an empty
`[]` with no initializer (GS0411) cannot be sized. When an explicit count is
spelled alongside an initializer (`stackalloc [n]T{…}`), the two must agree
exactly, mirroring C# (GS0412); use the count-inferred shape to avoid repeating
the length.

## Ambiguous imported static member diagnostic (GS0414)

| ID | Severity | Description |
|----|----------|-------------|
| GS0414 | Error | An unqualified reference to a `shared` member is ambiguous between two or more imported types (the G# form of C# `using static`). Qualify it with the owning type name.  | |

GS0414 supports the static-import feature (issue #1201): a non-alias type
import (`import Ns.Type`) brings that type's `shared` members into scope for
unqualified reference. When the same bare name is exposed by `shared` members of
two or more imported types, the reference cannot be resolved unambiguously and
GS0414 fires — but only at the use site, mirroring C# `using static`
ambiguity. Qualify the call or identifier with the owning type
(`EnumUtil.GetValues()`) to disambiguate. See ADR-0134.

## `sizeof` operand diagnostic (GS0415)

| ID | Severity | Description |
|----|----------|-------------|
| GS0415 | Error | The operand of `sizeof(T)` must be an unmanaged type — a blittable primitive, an enum, a value struct whose fields are all unmanaged, a pointer, or a generic type parameter constrained `unmanaged`.  | |

GS0415 supports the user-facing `sizeof(T)` expression (issue #1336, ADR-0135).
`sizeof` yields the size in bytes of an unmanaged type and lowers to the CIL
`sizeof` opcode, which accepts a generic type token. A reference type
(`sizeof(string)`), or a generic type parameter that is *not* constrained
`unmanaged` (`func F[T any]() int32 { return sizeof(T) }`), has no statically
known unmanaged size and is rejected with GS0415. Constrain the type parameter
`unmanaged` (`[T unmanaged]`) to make `sizeof(T)` legal.

## Nesting-too-deep diagnostic (GS0417)

| ID | Severity | Description |
|----|----------|-------------|
| GS0417 | Error | The source nests expressions, types, statements, patterns, or string-interpolation holes more deeply than the compiler's recursion limit. Simplify or flatten the nesting.  | |

GS0417 supports the parser/lexer recursion-depth guard (issue #1602). The
recursive-descent parser enforces a hard recursion limit at every self-nesting
parse family (expressions, type clauses, statements, patterns, nested type
declarations, and the speculative type-clause lookahead), and the lexer bounds
the nesting of string-interpolation holes (`"${"${…}"}"`). Without the guard,
a few kilobytes of deeply nested input — e.g. thousands of unbalanced
`a[a[a[…` or `((((…`, exactly what an editor buffer looks like mid-edit —
terminate the whole process with an uncatchable `StackOverflowException`.
Past the limit the parser reports GS0417 once, recovers with a placeholder
node, and finishes the parse normally, mirroring Roslyn's CS8078 ("an
expression is too long or complex to compile"). Realistic programs never
approach the limit; generated code that does should be restructured to reduce
nesting depth.

## Additional language diagnostics (GS0270–GS0418)

| ID | Severity | Description | Example trigger |
|----|----------|------------------------------|-----------------|
| GS0270 | Error | The `as` operator targets a non-nullable value type; use a reference type or nullable value type instead.  | |
| GS0274 | Error | `nil` is supplied to a non-nullable parameter of an attribute constructor.  | |
| GS0275 | Warning | `.GetAwaiter().GetResult()` is called directly on a `ValueTask` or `ValueTask[T]`; convert it to `Task` with `.AsTask()` first.  | |
| GS0278 | Error | A convenience initializer does not delegate to another initializer with `init(args)` before any other statement.  | |
| GS0279 | Error | A convenience initializer declares `: base(args)` instead of delegating to another initializer with `init(args)`.  | |
| GS0280 | Error | An `init(args)` constructor self-delegation appears outside a class constructor body.  | |
| GS0281 | Error | A designated initializer delegates to a sibling `init(args)` overload instead of chaining to its base class.  | |
| GS0282 | Error | A convenience initializer delegates to itself.  | |
| GS0283 | Error | No sibling initializer overload matches an `init(args)` self-delegation call.  | |
| GS0284 | Error | An explicit `init(...)` duplicates the constructor synthesized from the class's primary-constructor parameters.  | |
| GS0293 | Error | No enclosing loop is labeled `<label>` (in `break <label>` / `continue <label>`). |
| GS0294 | _Retired_ | Previously: labels could only be applied to loop statements. Non-loop labels are now valid `goto` targets; this diagnostic is no longer emitted. |
| GS0295 | Warning | Label `<label>` shadows an enclosing loop label of the same name; the inner label wins for nested `break` / `continue`. |
| GS0296 | Error | The right-hand side of an `if let` / `guard let` / `while let` binding must be of nullable type; non-nullable initializers have nothing to strip. |
| GS0297 | Error | A `guard let` else block can fall through instead of unconditionally exiting with `return`, `throw`, `break`, or `continue`. |
| GS0300 | Warning | A null-conditional index access uses a non-nullable receiver; use ordinary indexing instead. |
| GS0301 | Error | Null-conditional indexing `?[]` is not allowed on the left-hand side of an assignment. Use a plain `[]` after a nil-check, an `if let` binding, or the `??=` compound assignment instead. |
| GS0306 | Error | A declaration uses the removed `type Name <kind>` form instead of putting the aggregate-kind keyword first. |
| GS0307 | Error | The `record` keyword has been removed; use `data struct Name` (value-typed) or `data class Name` (reference-typed). |
| GS0308 | Error | `inline` is applied to an aggregate kind other than `struct`. |
| GS0309 | Error | `open` is applied to an aggregate kind other than `class`. |
| GS0310 | Error | `sealed` is applied to an aggregate kind other than `class` or `interface`. |
| GS0311 | Error | `data` and `inline` are combined on the same declaration. |
| GS0312 | Error | `open` and `sealed` are combined on the same declaration. |
| GS0313 | Warning | Non-exhaustive `switch` over a sealed-hierarchy base or discriminated-union enum. |
| GS0316 | Error | `'<form>' is provided by 'Gsharp.Extensions.Go'. Add 'import Gsharp.Extensions.Go' or use 'scope' + 'async'/'await' instead.` |
| GS0317 | Error | `'<name>' is provided by 'Gsharp.Extensions.Go'. Add 'import Gsharp.Extensions.Go' or call '<suggestion>' directly.` |
| GS0330 | Error | An event is declared inside an interface `shared` block; interface static events are not supported. |
| GS0331 | Error | `<Kind> '<C>' does not implement static-virtual interface method '<I>.<Name>', and the interface provides no default body.` |
| GS0332 | Error | `<Kind> '<C>' declares instance method '<Name>' but interface '<I>.<Name>' is static-virtual; declare it inside a 'shared { … }' block.` |
| GS0333 | Error | A constrained static access through a type parameter either is not a member name or names no static-virtual member on any interface constraint. |
| GS0334 | Error | `Private interface member '<I>.<Name>' is not accessible from this context; private helpers are visible only to sibling members of the same interface.` |
| GS0335 | Error | `Private interface method '<I>.<Name>' must declare a body; abstract private helpers are not allowed.` |
| GS0336 | Error | `<Kind> '<C>' declares method '<Name>' that clashes with private interface helper '<I>.<Name>'; private interface helpers are interface-internal and cannot be overridden by implementers.` |
| GS0337 | Error | `Modifier 'private' on interface member '<Name>' of kind '<Kind>' is not supported. The v1 surface accepts 'private' only on instance / static methods.` |
| GS0338 | Error | `base[IFoo]` names an interface not implemented by the enclosing type, or appears outside an instance member. |
| GS0339 | Error | `Interface '<I>' does not declare a member named '<Name>' reachable via 'base[<I>]'.` |
| GS0340 | Error | `Interface member '<I>.<Name>' is abstract; there is no default implementation to delegate to via 'base[<I>]'.` |
| GS0341 | Error | `Interface member '<I>.<Name>' is a private helper and is not reachable via 'base[<I>]'.` |
| GS0353 | Error | Delegate-typed P/Invoke parameter `<name>` of type `<T>` requires the delegate declaration to be annotated with `@UnmanagedFunctionPointer(CallingConvention.Cdecl)` (or a matching calling convention). |
| GS0354 | Error | Unknown calling convention `<name>` on an `unmanaged` function-pointer type clause. Use one of: `Cdecl`, `Stdcall`, `Thiscall`, `Fastcall`. |
| GS0355 | Error | Returning a managed delegate `<T>` from a P/Invoke declaration is not supported. Declare the return as `unmanaged[CC] (...) -> R` (a raw function pointer) or `nint` and wrap manually with `Marshal.GetDelegateForFunctionPointer`. |
| GS0356 | Error | Raw function-pointer type clause is missing its calling-convention slot. Expected `unmanaged[Cdecl | Stdcall | Thiscall | Fastcall] (...) -> R`. |
| GS0361 | Error | Type parameter `<T>` carries the mutually exclusive constraints `<first>` and `<second>`. The two combinations that fire today are `class struct` (a type cannot simultaneously be a reference type and a value type) and `struct init()` (the `init()` flag is redundant because the CLR's `NotNullableValueTypeConstraint` already implies `DefaultConstructorConstraint` per ECMA-335 II.10.1.7). |
| GS0362 | Error | The bare `default` literal can only be used where its type is known from context. Use `default(T)` to spell the default value of an explicit type. |
| GS0363 | Error | The C# `params` keyword is not supported in G#. Use the canonical variadic spelling `name ...T` (Go-style); inside the function body the parameter has type `[]T`. |
| GS0364 | Error | A function signature may declare at most one variadic parameter. |
| GS0365 | Error | A variadic parameter slot in an anonymous function-type clause must use the slice form `[]T`; got `<typeName>`. |
| GS0366 | Error | The `map[K]V` type-clause spelling has been removed; use `map[{key},{value}]` instead. |
| GS0367 | Error | A `yield` appears inside a `try` block that has a `catch` clause.  | |
| GS0369 | Error | A collection initializer targets a type with no accessible `Add` method or settable indexer.  | |
| GS0370 | Error | An indexer declaration has no index parameters.  | |
| GS0371 | Error | An indexer declaration has no `get` or `set` accessor body.  | |
| GS0372 | Error | An init-only property is assigned outside a constructor, object initializer, or `init` accessor for the same instance.  | |
| GS0373 | Error | A property declares both `set` and `init` accessors.  | |
| GS0374 | Error | A static property declares an `init` accessor.  | |
| GS0379 | Error | `'{Type}.{member}' is inaccessible due to its protection level: a 'protected' member is only accessible within '{Type}' and types derived from it.` |
| GS0380 | Error | `'protected' is only allowed on members of an 'open class' (a type that can be inherited). Mark the enclosing class 'open', or use a different accessibility.` |
| GS0381 | Error | A class participates in a direct or transitive inheritance cycle.  | |
| GS0383 | Error | `'base' is not valid here: '<T>' must be an instance member of a class that has a base class to use 'base.Member(...)'.` |
| GS0384 | Error | `Base class '<Base>' does not declare an accessible method named '<Name>' to call via 'base'.` |
| GS0385 | Error | `'base[<Type>]' is not valid: '<Type>' is not a base class of '<T>'. Use the immediate base class name, or the plain 'base.Member(...)' form.` |
| GS0392 | Error | A range expression slices a type that has no supported array, slice, string, span-like, or `System.Range` indexer shape.  | |
| GS0396 | Error | **Retired.** Default-bodied static-virtual interface properties (`prop Name T { get { … } }`) are now supported, so this diagnostic is no longer raised. |
| GS0397 | Error | `Type '<C>' does not implement static-virtual interface property '<I>.<Name>' (<detail>).` Not raised for a fully default-bodied static property (the interface supplies the body). |
| GS0398 | Error | Unmanaged pointer to a non-blittable pointee. | An `unsafe`-context `*T` whose pointee `T` is a managed reference type or otherwise non-blittable (e.g. `*string`, or a struct with a managed field); only blittable primitives, pointers-to-pointers, and blittable user/value structs are legal pointees. |
| GS0399 | Error | `stackalloc` element type must be a blittable (unmanaged) type. | A `stackalloc [n]T` whose element type `T` is a managed reference type or otherwise non-blittable (e.g. `stackalloc [4]string`); only blittable primitives and pointers are legal `stackalloc` element types. |
| GS0400 | Error | A `fixed` statement requires an `unsafe` context. | A `fixed <name> *T = <source> {... }` statement used outside an `unsafe` context (function, `unsafe {... }` block, or unsafe type). Because it binds a raw unmanaged pointer, `fixed` is legal only inside `unsafe`, consistent with `*T` pointer gating. |
| GS0401 | Error | A `fixed` statement source is not pinnable, or the pointer's element type does not match. | The source of a `fixed` statement must be a managed array/slice (`[]T`), a `string`, or a span-like type exposing a public instance `ref T GetPinnableReference()` (e.g. `System.Span[T]` / `System.ReadOnlySpan[T]`), and the bound pointer's pointee type must match the buffer's element type (`uint16`/`char` interchangeable for `string`). Reported for a non-pinnable source (e.g. a scalar, or a type without `GetPinnableReference`) or a pointee/element-type mismatch. |
| GS0402 | Error | The operand of an increment/decrement operator must be an assignable variable, field, or indexed element. | A prefix or postfix `++`/`--` applied to something that is not a writable lvalue, e.g. `5++`, `(a + b)--`, or a function-call result. The operand must be a mutable variable, field, array element, or indexer target. |
| GS0403 | Error | Cannot dereference, index, or perform arithmetic on a void pointer `*void`. | A true void-element pointer `*void` (C# `void*`) carries no element type, so `*p`, `p[i]`, `p + i`, `p - i`, and `p - q` are rejected; cast it to a typed pointer `*T` (e.g. `*int32(p)`) first. Casts to/from typed pointers and `nint`, and comparison/equality, are allowed. |
| GS0404 | Error | A managed function-pointer type `*func(...) R` requires an `unsafe` context. | A managed function-pointer type clause `*func(T1, T2) R` used outside an `unsafe` context; like the raw pointer `*T`, a function pointer is only legal inside `unsafe`. |
| GS0405 | Error | Cannot take the address of this method as a function pointer. | `&Method` where the operand is not a single static/free, non-generic method (e.g. an instance method, an overloaded method group, or a generic method), or it is used outside an `unsafe` context. |
| GS0406 | Error | A fixed-size buffer field `fixed name [N]T` requires an `unsafe` context. | A `fixed name [N]T` buffer field declared in a non-`unsafe` struct; declare it inside an `unsafe struct`. |
| GS0407 | Error | A fixed-size buffer field must have a fixed-length array element type `[N]T`. | A `fixed name <T>` field whose type clause is not a fixed-length array `[N]T`. |
| GS0408 | Error | A fixed-size buffer field must have a positive length. | A `fixed name [N]T` field with `N <= 0`. |
| GS0409 | Error | Fixed-size buffer element type is not supported. | A `fixed name [N]T` field whose element type is not a blittable primitive (`bool`, `int8…int64`, `uint8…uint64`, `char`, `float32`, `float64`). |
| GS0413 | Error | `Cannot call the abstract base member '<Base>.<Name>' via 'base'; it has no base implementation to delegate to.` |
| GS0416 | Error | A list pattern contains more than one slice (`..`) subpattern.  | |
| GS0418 | Error | A `using` or `await using` statement uses tuple or named deconstruction instead of one variable declaration.  | |

## Defer with by-reference arguments (GS0460)

| ID | Severity | Description |
|----|----------|-------------|
| GS0460 | Error | The operand of a `defer` statement is a call with one or more `ref`, `out`, or `in` arguments.  | |

`defer` eagerly captures each argument's evaluated value into a fresh readonly
local ahead of the deferred invocation (issue #1635). A by-reference argument's
value *is* the address of its target storage, which cannot be spilled into an
ordinary local without either aliasing an unrelated temp (silently breaking the
by-ref contract) or requiring verifiable-IL support for spilled managed pointers
that the emitter does not provide. Rather than mis-defer the call, `defer` on
such a call is rejected outright. Restructure so the deferred work takes its
arguments by value, or wrap the by-ref call in a `func` captured by the
`defer`.

## Non-constant explicit enum member value (GS0467)

| ID | Severity | Description |
|----|----------|-------------|
| GS0467 | Error | An enum member's explicit `= expr` value isn't a constant int32 expression.  | |

Issue #1912 adds explicit enum-member values (`Banana = 2`, `Unknown = -1`,
`ReadWrite = Read | Write`, or an alias `DefaultError = ServerError`), constant-
folded at bind time since G# has no general enum-member initializer semantics
(a member's runtime value must be knowable without executing any code). The
folder accepts int literals; unary `+`/`-`/`^` (ones-complement); the binary
operators `+ - | & ^ << >>`; parenthesized sub-expressions; and references to
already-declared sibling members by bare name. Anything else (a function call,
a non-sibling identifier, a floating-point literal, …) is rejected with GS0467.

## Explicit-interface qualifier clause (GS0492–GS0495)

| ID | Severity | Description |
|----|----------|-------------|
| GS0492 | Error | An explicit-interface qualifier clause (`func (X) M(...)` / `prop (X) P T` / `event (X) E T`) references a type that is not an interface.  | |
| GS0493 | Error | An explicit-interface qualifier clause references an interface the containing type does not implement.  | |
| GS0494 | Error | An explicit-interface qualifier clause's interface is implemented, but no member on it matches the declared name, signature, or accessor shape.  | |
| GS0495 | Error | Two members of the same containing type both carry an explicit-interface qualifier clause that resolves to the same interface member.  | |

ADR-0149 adds a dedicated qualifier clause for explicit interface implementations: `func (IFoo) M(...) T { ... }`, `prop (IFoo) P T { ... }`, `prop (IFoo) this[i int32] T { ... }`, and the analogous `event (IFoo) E T` form. Unlike an ordinary member, the qualifier's interface type must be one of the containing type's implemented interfaces (GS0493) and must be an interface at all (GS0492), and the declared member must exactly match one of that interface's members by name, parameter/accessor shape (GS0494). Two clauses on the same containing type that resolve to the *same* interface member are rejected as a duplicate implementation (GS0495) — this is distinct from two *different* explicit implementations (of different interface members, or the same simple name under different interfaces) sharing a plain source name, which is the entire point of the feature and is explicitly permitted.

## Additional compiler diagnostics (GS0461–GS0501)

| ID | Severity | Description |
|----|----------|-------------|
| GS0461 | Error | A `lock` statement's operand is not a reference type.  | |
| GS0462 | Error | A generic local function is not declared as a `let`-bound function literal.  | |
| GS0463 | Error | A generic local function captures a variable from its enclosing scope.  | |
| GS0465 | Error | `@assembly:InternalsVisibleTo(...)` does not contain exactly one string literal naming the friend assembly.  | |
| GS0466 | Error | A named argument is used on an attribute type declared in the same compilation; use a constructor argument instead.  | |
| GS0468 | Error | A local function references a type parameter belonging to an enclosing method or class that its emitted method cannot close over.  | |
| GS0469 | Error | A `goto` names no label in the enclosing function.  | |
| GS0470 | Error | Two `goto` labels in the same function have the same name.  | |
| GS0471 | Error | An explicit-arity open-generic `typeof` name resolves to different CLR types from multiple imported namespaces.  | |
| GS0472 | Error | Code outside the declaring top-level type accesses one of its private members.  | |
| GS0473 | Error | An expression-tree lambda contains a language construct that cannot be represented in an expression tree.  | |
| GS0474 | Error | A lambda targets `Expression[T]` where `T` is not a delegate type.  | |
| GS0475 | Error | One declaration in a partial-type group omits `partial`.  | |
| GS0476 | Error | Partial declarations disagree on whether the type is a class, struct, or interface.  | |
| GS0477 | Error | Partial declarations specify conflicting accessibility modifiers.  | |
| GS0478 | Error | Partial declarations specify conflicting `open` or `sealed` modifiers.  | |
| GS0479 | Error | A `data`, `inline`, or `ref` modifier appears on only some declarations of a partial type.  | |
| GS0480 | Error | Partial declarations have different type-parameter names, arity, order, or constraints.  | |
| GS0481 | Error | Partial declarations have conflicting base clauses or more than one base-constructor argument list.  | |
| GS0482 | Error | More than one partial declaration supplies a primary constructor.  | |
| GS0483 | Error | A partial type contains more than one `deinit`.  | |
| GS0484 | Error | `partial` is applied to an aggregate kind other than class, struct, or interface.  | |
| GS0485 | Error | An anonymous object declares an `init` or `deinit` member.  | |
| GS0486 | Error | A field in an anonymous object with a base type, method, or event omits its explicit type.  | |
| GS0487 | Error | A data class or struct declares `ToString` with a shape other than public, instance, non-generic, synchronous, parameterless, and returning `string`.  | |
| GS0490 | Error | A requested structural projection is unsafe or incomplete; the diagnostic explains the incompatible member or shape.  | |
| GS0496 | Error | A bare source type name is ambiguous between same-named types declared by multiple imported packages.  | |
| GS0497 | Error | A function literal is an async iterator; declare a named async iterator and reference it instead.  | |
| GS0498 | Error | A `goto` enters a `catch` or `finally` handler from outside that handler.  | |
| GS0499 | Error | A field assignment targets a temporary struct value rather than writable storage.  | |
| GS0500 | Error | A user-defined compound-assignment operator is not an instance method with exactly one parameter and no return value.  | |
| GS0501 | Error | Imported metadata exposes multiple public parameterless members with the same name, so reflection lookup is ambiguous.  | |

## Interface property setter-kind mismatch (GS0502)

| ID | Severity | Description |
|----|----------|-------------|
| GS0502 | Error | A property implementation uses `init` where its interface requires `set`, or vice versa. |

An `init` accessor has a different CLR signature from `set` because its return
type carries `modreq(IsExternalInit)`. The accessor kinds must match in either
direction. A positional `data class` or `data struct` member is init-only, so
it can satisfy a get-only interface property but not a settable one. Declare
the property explicitly with a `set` accessor. An init-only interface property
must instead be implemented with a matching `init` accessor. Static interface
properties cannot declare `init` accessors.

## Nullable delegate invocation diagnostics (GS0503)

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0503 | Error | A nullable delegate receiver cannot be called directly without a valid non-null narrowing. | `func Run(d System.Action[int32]?) { d(1) }` |

Use `?(...)` for null-safe invocation of any delegate receiver. Alternatively,
bind the delegate with `if let`, or assert non-null with `!!` before calling.

## Interface property type mismatch (GS0504)

| ID | Severity | Description |
|----|----------|-------------|
| GS0504 | Error | An ordinary property has a different type from the interface property it would implement. |

The diagnostic names the implementing type and property, the interface
property, and both the required and actual types. Get-only properties may
erase reference nullability covariantly: a `string` implementation can satisfy
a `string?` contract. A declared unconstrained `T?` slot erases to `T`, so
`I[int32]` requires an `int32` implementation, not `int32?`. Settable
properties remain source-nullability invariant, and their emitted slot type
must also match. The same erasure rule applies recursively inside slices,
arrays, and generic constructions. Declared value-type nullability is never
erased: `int32` cannot implement a get-only `int32?` property because the CLR
types are `System.Int32` and `System.Nullable<System.Int32>`.

## Unconstrained nullable iterator call (GS0505)

| ID | Severity | Description |
|----|----------|-------------|
| GS0505 | Error | A call cannot choose between compiler-generated reference-type and value-type variants of a nullable iterator because the caller's type parameter is unconstrained.  | |

Add a `struct`, `class`, or base-class constraint to the named type parameter.
Ordinary user-written overload ambiguities continue to report GS0266.

## Suspension inside fixed statement (GS0506)

| ID | Severity | Description |
|----|----------|-------------|
| GS0506 | Error | An `await`, `await for`, `await using`, or `yield` suspension point appears inside a `fixed` statement. |

A pinned region cannot survive an async or iterator suspension because the
generated state machine would have to resume by branching into the protected
region. Move the suspension point outside the `fixed` statement. Suspension in
a lambda declared inside `fixed` remains valid because the lambda runs in a
different method.

## Unconstrained nullable sequence element (GS0508)

| ID | Severity | Description |
|----|----------|-------------|
| GS0508 | Error | A nullable sequence element uses a type parameter that is not constrained to `struct` or a reference type. |

`sequence[T?]` needs one stable CLR element representation. Iterator return
types are specialized into `class` and `struct` variants automatically.
Other unconstrained sequence type positions still require an explicit
`struct`, `class`, or base-class constraint.

A call from another unconstrained generic context cannot select either
specialized iterator variant. Constrain the enclosing type parameter to
`struct`, `class`, or a base class. Named or explicit arguments do not resolve
that call: until [#2958](https://github.com/DavidObando/gsharp/issues/2958),
it reports GS0266, and a nullable value-type argument may instead report
GS0152. G# rejects source overloads differentiated only by constraints with
GS0264, even though iterator specialization synthesizes equivalent variants.

## P/Invoke interpreter boundary (GS0514, retired)

GS0514 marked P/Invoke declarations as unrunnable under the tree-walking
interpreter ([ADR-0152](adr/0152-interpreter-native-call-boundary.md)). The
evaluator — and with it this diagnostic — was deleted in
[ADR-0156](adr/0156-gsi-emit-to-memory-execution.md) Phase 3c; every driver
executes emitted code, where P/Invoke runs natively.

## Explicit-layout reference storage (GS0518)

| ID | Severity | Description |
|----|----------|-------------|
| GS0518 | Error | An explicit-layout type places a reference-typed field at a misaligned offset or overlaps it with non-reference storage. The CLR rejects both layouts; pointer-align the reference and keep non-reference fields outside its storage. |

## ByRefLike interpolation on emitted paths (GS0519)

| ID | Severity | Description |
|----|----------|-------------|
| GS0519 | Error | A ByRefLike value without a usable parameterless `ToString()` method cannot be used as an interpolation hole on emitted execution paths. |

Emitted interpolation routes ByRefLike holes through their user-declared or
CLR `ToString()` method because
`DefaultInterpolatedStringHandler.AppendFormatted<T>` rejects ByRefLike
generic arguments. GS0519 is the source-anchored fallback when no usable
parameterless method is available, preventing a GS9998 reflection exception.

## Channel declaration requires an initializer (GS0520)

| ID | Severity | Description |
|----|----------|-------------|
| GS0520 | Error | A `chan T` global or field is declared without an initializer. An auto-created channel has no sensible default (buffer size, ownership), so channels are carved out of the empty-instance zero values; initialize with `make(chan T)` or `make(chan T, capacity)`, or declare the slot as `(chan T)?` if the channel is genuinely optional. A **local** channel declaration is legal without an initializer: locals are flow-checked instead, and only an unassigned **use** is an error (GS0522 below). |

The other magic collection types (`map[K, V]`, `[]T`, `[N]T`, `sequence[T]`)
bind a sound empty instance when declared without an initializer
([ADR-0159](adr/0159-magic-collection-zero-values-and-nil-comparison.md)); a
channel cannot, because bounded-versus-unbounded and capacity are semantic
decisions `make` exists to force. Globals and fields are readable from any
function (they are emitted as static or instance fields), so they must
initialize at the declaration. A genuinely optional channel is spelled with
the parenthesized nullable form `(chan T)?` (issue #3315): the slot zero
value is `nil`, nil comparison and `?`-flow narrowing apply, and
`make(chan T)` assigns into it. A trailing `?` without parens binds to the
element type — `chan int32?` is a channel of nullable `int32` — consistent
with `[]T?` and `(T) -> R?`.

## Channel local possibly used before assignment (GS0522)

| ID | Severity | Description |
|----|----------|-------------|
| GS0522 | Error | A use of a channel-typed local is reachable by a control-flow path with no preceding assignment. A bare `chan T` slot has no zero value, so every path from the declaration to a use must assign it first — e.g. `c = make(chan T)` or via an `out` argument position. |

This is the definite-assignment relaxation recorded as follow-up (a) in
ADR-0159 (issue #3316): declaring an uninitialized `chan T` local is free,
and the C# CS0165 model applies at use sites — an assignment in only one
`if` arm, only inside a loop body (which may run zero times), or only in a
`try` body (which an exception may skip) does not count; an assignment in
every `switch`/`select` arm, in a `finally`, or before the use on every path
does. A function literal checks captured channel locals against the
assignment state at the capture point. Locals whose types **have** sound
zero values (ints, strings, structs, and the ADR-0159 magic collections)
keep G#'s documented zero-value initialization and are never flow-checked —
this analysis applies only to kinds with no usable zero value.

## Pointer generic type arguments (GS0521)

| ID | Severity | Description |
|----|----------|-------------|
| GS0521 | Error | Pointer and function-pointer types cannot be used as generic type arguments because the CLR cannot instantiate generic types with them. |

## Nil comparison against a bare collection type is statically constant (GS0523)

| ID | Severity | Description |
|----|----------|-------------|
| GS0523 | Warning | A `== nil` / `!= nil` comparison whose non-nil operand's static type is a bare (non-`?`) `map[K, V]`, `[]T`, `[N]T`, `[,]T`, or `chan T`. With sound empty-instance zero values (and GS0520's mandatory channel initializer) such a value can never be nil, so the comparison is always false (`==`) or always true (`!=`) — typically a Go porting artifact. Remove the dead check, or declare the slot with the `?` spelling (`map[K, V]?`, `[]?T`, `[,]?T`, `(chan T)?`) if it is genuinely optional. |

The warning is static-type based and fires for both operand orders. It does
NOT fire for `?`-typed operands (including interop values surfaced as `T?`,
which are the comparison's real use case), nor for a smart-cast-narrowed read
of a `?`-declared slot — v1 keys on the declared type, leaving a
"redundant re-check" nuance as a possible future refinement. `sequence[T]` is
excluded from v1: its nil comparison predates ADR-0159 (#796) and bare
sequence values commonly cross interop boundaries. Known accepted corners
(warning severity, suppressible via `/nowarn:GS0523`): an explicit
`= default` initializer can reintroduce nil into a bare slot (issue #3319
closed the other former corner — a bare struct-typed local's own
magic-collection fields — so it no longer applies).

## Stack-only CLR values in the interpreter (GS0511, retired)

GS0511 marked stack-only (`ByRefLike`) CLR values the boxed-storage
interpreter could not represent. The evaluator — and with it this diagnostic —
was deleted in [ADR-0156](adr/0156-gsi-emit-to-memory-execution.md) Phase 3c;
every driver executes emitted code, where ByRefLike values work natively.

## Interpreter deinitializer boundary (GS0510, retired)

GS0510 warned that a `deinit` finalizer would not run under interpreted
execution ([ADR-0068](adr/0068-deinit-destructor-support.md)). The evaluator —
and with it this warning — was deleted in
[ADR-0156](adr/0156-gsi-emit-to-memory-execution.md) Phase 3c; deinitializers
run as real CLR finalizers on every driver.

## Internal compiler error details (GS9998)

`GS9998` is the *silent emit failure* diagnostic. When the compiler can recover
the responsible expression or statement, it reports that source file and span.
When no trustworthy source anchor exists, it reports `error GS9998: ...`
without a file or coordinates. A `GS9998` anchored at `(1,1,1,1)` against
`gsc.dll` or an arbitrary source file is itself a bug — please file an issue.

The message format is `<ExceptionType>: <description>`, for example `InvalidOperationException: Variable 'x' has no local slot`. This tells you what the compiler was trying to do when it failed, even though the underlying bug may not be your fault.

Suppressing or `WarnAsError`-ing `GS9998` follows the same MSBuild plumbing as any other diagnostic (`/nowarn:GS9998` or `<NoWarn>GS9998</NoWarn>`), though suppressing it is not recommended since it masks genuine compiler bugs.
