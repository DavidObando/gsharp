# ADR-0134: Static imports — `import Ns.Type` exposes `shared` members for unqualified use (C# `using static`)

- **Status**: Accepted
- **Date**: 2026-06-28
- **Phase**: Phase 8 — primitive coverage / language conformance
- **Related**: issue [#1201](https://github.com/DavidObando/gsharp/issues/1201) (this change), ADR-0053 (static members on user types — `shared` block), ADR-0112 (canonical `TypeMemberModel` member resolution), ADR-0115 (C#→G# migration tool `cs2gs`)

## Context

G# already had an `import` declaration that brought a package / CLR namespace
into scope (`import System`), introduced an alias (`import x = Ns.Type`), or
gated a feature surface (`import Gsharp.Extensions.Go`, ADR-0082). What it did
**not** have was an equivalent of C#'s `using static <Type>`: a way to bring a
type's **static** members into scope so they can be referenced **unqualified**.

Concretely, given a `class` with a `shared { … }` block:

```gsharp title="util.gs"
package p.aux
class EnumUtil {
    shared {
        func GetValues() []int32 { return []int32{1, 2, 3} }
    }
}
```

a consumer that wrote `import p.aux.EnumUtil` and then called `GetValues()`
unqualified got `GS0130: Function 'GetValues' doesn't exist.` The trailing
segment `EnumUtil` was treated as just another namespace path component; the
type's `shared` members were never hoisted. The only thing that compiled was
the **namespace** import (`import p.aux`) followed by a **qualified** call
(`EnumUtil.GetValues()`).

This gap surfaced through the `cs2gs` migration tool (ADR-0115). Real C# such
as Oahu.Foundation's `Auxiliary/EnumChainTypeConverter.cs` and
`Auxiliary/EnumConverter.cs` use `using static Oahu.Aux.EnumUtil;` and then call
`GetValues<TEnum>()` unqualified. cs2gs translated `using static X` to a plain
`import X` and, for non-generic bare static calls, qualified the member through
its owning type — but **generic** bare static calls (`GetValues<TEnum>()`) were
emitted bare and hit `GS0130` because gsc had nowhere to resolve them. The
translation was neither faithful (the qualification is not what the author
wrote) nor correct (the generic case did not compile).

## Decision

### 1. `import Ns.Type` hoists the type's `shared` members

When the trailing dotted path of a **non-alias**, **non-implicit** `import`
names a **type owned by the program** — a top-level `class` (a `StructSymbol`
with `IsClass = true`) that carries a `shared { … }` block — the import, in
addition to whatever namespace effect it has, brings that type's `shared`
(static) members into scope for **unqualified** reference. Hoisted members are:

- static methods (including **generic** static methods — `GetValues[TEnum]()`),
- static fields,
- static properties,
- static consts.

This mirrors C# `using static`, where the static methods, fields, properties,
const fields, and nested types of the named type become available without
qualification.

### 2. Resolution is a fallback after ordinary lookup

The static-import lookup is consulted **only when ordinary resolution fails** —
it never shadows a local, parameter, same-type member, or top-level `func`.

- **Unqualified call** `f(args)`: `OverloadResolver.BindCallExpression`, just
  before it would emit `GS0130` (`ReportUndefinedFunction`), iterates the
  imported static types and looks for one that exposes a `shared` method named
  `f`. The existing `bindUserTypeStaticCall` callback (wired in `Binder.cs`)
  binds the call, so optional parameters, variadics, and **generic type
  inference** all behave exactly as for the qualified `Type.f(args)` form.
- **Unqualified identifier** `m`: `ExpressionBinder.BindNameExpression`, after a
  method-group bind fails and before `ReportUndefinedVariable`, calls
  `TryBindImportedStaticMember`, which resolves `m` to a `shared`
  field / property read or a method-group on the imported type via
  `BindUserTypeStaticMemberAccess`.

Both paths route member lookup through the canonical **`TypeMemberModel`**
(ADR-0112) rather than re-implementing static-member search, so inheritance and
member-kind rules stay consistent with qualified access.

### 3. Only **type** imports hoist — namespace and alias imports do not

Following C#:

- `import p.aux` (a **namespace** import) does **not** hoist statics —
  `GetValues()` still reports `GS0130`. Only `import p.aux.EnumUtil` does.
- `import x = p.aux.EnumUtil` (an **alias** import) introduces the alias `x`
  only; it does not hoist `EnumUtil`'s members. (C#'s `using static` cannot be
  aliased; an aliased `using` names a type/namespace alias, not a static
  import.)

An import is treated as a static-import candidate when it is not an alias, not
implicit, and its dotted `Target` resolves to an owned `class` whose
`PackageName.Name` matches the import's leading segments (or, in the default
package, the bare type name). The resolved set is cached on `BinderContext`,
keyed by the import and struct counts, so repeated unqualified lookups in a
compilation unit do not re-walk the import list.

### 4. Ambiguity is reported at the use site (`GS0414`)

If two or more imported types both expose a `shared` member with the referenced
name, the reference is **ambiguous** and reports the new diagnostic **`GS0414`**
— but, mirroring C# `using static`, only when the name is actually
**referenced**, never merely because two such imports coexist. The user
disambiguates by qualifying (`EnumUtil.GetValues()`), which always works.

### 5. `cs2gs`: emit `import X`, leave members **unqualified**

With gsc resolving unqualified imported statics, `cs2gs` (ADR-0115) is updated:

- A C# `using static X` still translates to a bare type import `import X`.
- The translator collects the set of `using static` target types per document
  (`CollectStaticUsingTargets`) and threads it into the declaration visitor.
  When a bare static call or a bare static field / property reference resolves
  to a member **whose owner is a `using static` target**, the translator
  **suppresses** the owning-type qualification and emits the reference **bare**.
  A bare static reference to a **sibling** type (not a `using static` target)
  is still qualified through its owner, as before (ADR-0115 §B.18), because a
  G# `shared` body has no implicit type scope.
- An **aliased** `using static X` (which has no unqualified-hoisting form)
  degrades to a plain import and emits an informational warning.

This makes the round-trip faithful: `using static Oahu.Aux.EnumUtil;` +
`GetValues<TEnum>()` becomes `import Oahu.Aux.EnumUtil` + `GetValues[TEnum]()`,
which now compiles.

## Consequences

- **Idiomatic migrations.** The Oahu.Foundation enum converters translate
  without the qualification workaround, and the generic `GetValues<TEnum>()`
  case compiles for the first time.
- **No new syntax.** `import Ns.Type` is unchanged at the grammar level; only
  binder resolution and the `cs2gs` qualification policy change. No new
  `SyntaxKind` or `BoundNodeKind` is introduced, so the coverage matrix is
  unaffected.
- **Faithful to C# precedence.** Static-import resolution is a strict fallback,
  so existing programs are unaffected — a name only resolves to an imported
  static when it would otherwise have been an error.

### Deviations from C# `using static`

- **Referenced CLR types now supported.** *(Follow-up, Oahu migration.)*
  Hoisting originally applied only to `shared` members of types compiled
  **together with** the consumer. It now also covers `public static` members of
  a **referenced CLR type** (a metadata type from another assembly): when a
  non-alias import's dotted target itself resolves to a CLR type
  (`import System.Math`, the cs2gs spelling of `using static System.Math`), an
  otherwise-unresolved unqualified call / identifier binds against that type's
  static members exactly like the qualified `Math.Sqrt(x)` / `Math.PI` form.
  `BoundScope.EnumerateStaticImportClrTypes` enumerates the candidates (a strict
  fallback consulted only after the owned-type search fails); the call path
  routes through the shared `BindAccessorCall` (qualified static-call) binder, so
  overload resolution, optional / variadic parameters, and generics behave
  identically to the qualified form. Cross-type ambiguity still reports `GS0414`.
- **Nested types.** C# `using static` also makes a type's accessible **nested
  types** available unqualified. G# does not yet hoist nested types through a
  static import; only `shared` data and function members are exposed.
- **Extension methods.** C# `using static` does not change extension-method
  lookup (that is `using <namespace>`). G# extension functions (ADR-0019) are
  unaffected by static imports.
