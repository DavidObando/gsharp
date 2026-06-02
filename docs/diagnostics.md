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
| GS0135 | Error | `async` modifier in a type clause is only valid before `sequence[T]` or `func(...)`. | `async int` in a type position. |
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
| GS0211 | Error | Attribute `[DllImport]` is recognised but not supported in v1.0; P/Invoke (extern function bodies) is a post-v1.0 feature. | `@DllImport("user32.dll") func MessageBox() {}` — emit support and the `extern` body marker arrive after v1.0. |

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
    Items ReadOnlySpan[int32]   // a ref struct may hold by-ref-like fields
    Label string
}
```

Such a type is emitted with `System.Runtime.CompilerServices.IsByRefLikeAttribute` (and the C# compiler's `[Obsolete]` guard marker), so the CLR treats it as stack-only. The same escape rules below apply to user-declared `ref struct` types exactly as they do to imported ones. The only relaxation is that a `ref struct` may itself hold by-ref-like fields (it is stack-only too); a static field of a `ref struct` is still rejected.

| ID | Severity | Description | Example trigger |
|----|----------|-------------|-----------------|
| GS0219 | Error | A by-ref-like (`ref struct`) value is used in a position that would let it escape the stack: boxing / converting it to a reference type (`object`, an interface, a delegate base), storing it in a field of a non-ref-struct (instance, primary-constructor, or static), capturing it in a closure, declaring it as a local in an `async` function or an iterator (where it would be hoisted into the heap-allocated state machine), or using it as a generic type argument. | `var o object = span` (box); a `class`/`struct` field typed `Span[int32]`; capturing a `ReadOnlySpan[char]` local inside `func() { ... }`; declaring a `Span[int32]` local in an `async` function; `List[ReadOnlySpan[int32]]`. |

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
| GS9004 | Error | By-ref value cannot escape its declaration scope. | Storing a `ref` parameter into a field that outlives the function. |
| GS9005 | Error | Cannot take the address of a constant. | `&myConst` where `myConst` is declared `const`. |
| GS9006 | Error | Pointer type cannot be a field type. | A `struct` field declared with a pointer or `ref` type. |

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
