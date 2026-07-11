# GSharp design v0.2 — locked language directions

_Status: living document. Companion to `~/gsharp-execution-plan.md` and `~/gsharp-gaps.md`. Supersedes v0.1 for everything except the historical Hello-World and Loop sketches._

This document records the cross-cutting design decisions that guide GSharp's evolution from its current Go-flavored mini-language toward a production-capable language for .NET 10. Each decision is the input to one or more execution phases and was locked in collaboration with the language owner. Future amendments require an ADR.

For the executable roadmap, see `~/gsharp-execution-plan.md`. For the gap analysis that motivated these decisions, see `~/gsharp-gaps.md`. For the per-decision rationale and consequences, see the ADRs under `docs/adr/`.

## Locked decisions

### D1 — Absence / null model (Kotlin-style)

Nullability is part of the type. Reference types are non-null by default; nullability is opted into with the postfix `?` operator. `nil` is the only inhabitant of the bottom of nullable types. Smart casts narrow nullable types to non-null after a flow-sensitive `!= nil` check.

```gs
let s : string  = "hello"   // non-null
let m : string? = nil       // nullable
let n = m?.length ?? 0      // safe call + null-coalescing
let k = m!!.length          // null-assert (throws if nil)
if m != nil {
  Console.WriteLine(m.length)   // smart cast: m is `string` here
}
```

See ADR-0001.

### D2 — Concurrency model (synthesis)

Three precedents converge: Go-shaped concurrency surface (`go`, `chan`, `<-`, `select`), .NET-style `async`/`await`, and Kotlin-style structured concurrency scopes. GSharp surfaces all three but lowers them onto a single runtime: .NET `Task` + `System.Threading.Channels.Channel<T>`.

```gs
async func fetch(url string) string { ... }

scope {
  go worker(ch)             // structured: spawned goroutines bound to scope
  result := <-ch            // channel receive
}                           // scope exits only when all goroutines finish or one fails
```

See ADR-0002.

### D3 — OO surface (data + light OO)

GSharp keeps a small, data-oriented core (`struct`, `data struct`, `interface`, `sealed interface`) and admits one OO escape hatch: `class` with single inheritance and `override`. Extension functions are the idiomatic way to add behavior to user types and to imported CLR types.

```gs
data struct Point(x, y int)              // synth equals/hash/copy/destructure
sealed interface Shape { }
class Circle : Shape { ... }             // single-inheritance OK; multi-inheritance is not
func (s string) shout() string {         // extension function
  return s.ToUpper() + "!"
}
```

See ADR-0003.

### D4 — Generics (both consumption and definition, with constraints)

GSharp adopts CLR-style reified generics and exposes them in a single phase. Both consumption (`List[int]`) and definition (`func Map[T, U any](…)`) ship together, with constraints.

See ADR-0004 and ADR-0020.

### D5 — Error handling (exceptions only, unchecked)

GSharp models errors with .NET exceptions. There are no checked exceptions, no `throws` clauses, and no Go-style `(T, error)` multi-return idiom. BCL exceptions propagate unchanged.

```gs
try {
  let n = Int.Parse(s)
} catch (e FormatException) {
  Console.WriteLine("not a number: $e")
} finally {
  cleanup()
}
```

See ADR-0005.

### D6 — Visibility model (explicit modifiers)

GSharp drops Go's capitalization-based visibility in favor of explicit modifiers: `public` (default), `internal`, `private`. This aligns with the CLR's visibility model and avoids friction with .NET BCL naming conventions.

```gs
public func Open(path string) File { ... }
internal func helper() { ... }
private const seed = 42
```

See ADR-0006.

### D7 — String interpolation syntax (Kotlin-style)

Strings use Kotlin-style interpolation: `$ident` for bare references, `${expr}` for expressions. No leading sigil on the string literal.

```gs
let name = "world"
Console.WriteLine("Hello, $name, age ${age + 1}")
```

See ADR-0007. Lexer-level grammar in ADR-0011.

### D8 — Variable binding keywords (Go-style + `let`)

GSharp keeps `var` (mutable), `const` (compile-time constant), and `:=` (short mutable declaration) from Go, and adds **`let`** (Swift/Rust flavor) for immutable runtime bindings.

```gs
var counter = 0          // mutable
const Pi = 3.14159       // compile-time constant
let user = fetchUser()   // immutable runtime binding
x := 1                   // short mutable
```

See ADR-0008.

### D9 — `switch` vs `when` (keep `switch` with rich semantics)

GSharp keeps the `switch` keyword (already reserved) but adopts C#/Kotlin-style semantics: `switch` is both a statement and an expression, supports pattern matching, and is exhaustive over `sealed` hierarchies and `enum`. Go's `fallthrough` is dropped (keyword remains reserved, parser rejects).

```gs
let label = switch x {
  case 0 -> "zero"
  case 1, 2, 3 -> "small"
  case > 100 -> "huge"
  default -> "other"
}
```

See ADR-0009.

### D10 — Aspirational samples policy (rewrite now, re-expand later)

Samples that use unparseable syntax (`samples/Loop.gs`'s C-style `for`, `i--`, `*count`, `args[0]`) are rewritten _today_ to today's parseable subset. Each phase's exit criteria re-expand samples to exercise newly-shipped features. An `samples/aspirational/` folder optionally holds unparseable-but-pedagogical samples explicitly marked as "future state."

See ADR-0010.

### D11 — Generic type-parameter brackets (Go-style `[T]`)

Both generic definition and instantiation use square brackets, consistent with `[]T` slice types and with Go's syntax.

```gs
func Map[T, U any](xs []T, f func(T) U) []U { ... }
let nums = List[int]()
let pairs = Map[string, int](names, parse)
```

The parser disambiguates `Map[T]` (call on non-generic with index arg) from `Map[T](…)` (generic instantiation followed by call) via lookahead. The exact rule is spec'd in ADR-0020.

See ADR-0020.

## Cross-cutting conventions

- **Authoritative semantics**: the interpreter (`Evaluator`) remains the source of truth (carried over from v0.1). New constructs ship with both interpreter and emit support; conformance tests assert identical observable behavior on both backends.
- **Diagnostics-first**: every new syntax kind ships with a parser diagnostic for misuse and a binder diagnostic for type-system violation.
- **Conformance suite**: every `.gs` file under `samples/` must build, run, and produce a golden stdout. CI runs the suite on every PR.
- **Phase gating**: see `~/gsharp-execution-plan.md` for the seven-phase roadmap. Each phase's exit criteria gate the next phase's start.

## Relationship to v0.1

v0.1 (`Gsharp-design-v0.1.md`) remains the historical record of GSharp's bootstrapping goals and its Hello-World / Loop sketches. The Loop sample in v0.1 uses syntax that does not parse today; it is annotated as aspirational in §1.1 below.
