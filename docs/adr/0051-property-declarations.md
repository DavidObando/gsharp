# ADR-0051: Property declarations — `prop` keyword with accessor bodies

- **Status**: Accepted
- **Date**: 2026-05-28
- **Related**: ADR-0003 (OO surface); ADR-0034 (imported CLR interop — property consumption); ADR-0047 (attribute syntax — `property` target kind); issue #195

## Context

GSharp can consume CLR properties on imported types (ADR-0034), but user-defined types emit only raw public fields. This breaks round-trip CLR compatibility: C# consumers see fields instead of properties, which fails WPF data binding, serialization frameworks (System.Text.Json's default policy), interface contracts requiring property accessors, and any reflection-based tool that queries `PropertyInfo`.

Issue #195 requests a Go/Kotlin-style approach to declaring properties with getters and setters that emit standard CLR property metadata (`PropertyDef` row + `get_X`/`set_X` specialname methods).

## Decision

Introduce a contextual keyword **`prop`** for declaring CLR properties inside `struct`, `data struct`, `class`, and `interface` bodies. Existing field declarations (`Name Type`) remain unchanged — they continue to emit raw fields. Properties are opt-in and explicit.

### 1. Grammar

```
property_declaration = annotations? accessibility_modifier? "prop" identifier type_clause property_body?
property_body        = "{" accessor_list "}"
accessor_list        = getter_accessor setter_accessor? | setter_accessor getter_accessor?
getter_accessor      = "get" ( block | ";" )?
setter_accessor      = "set" ( "(" identifier ")" )? ( block | ";" )?
```

The `prop` keyword is contextual — it is recognized only inside a type body (struct/class/interface). Outside type bodies, `prop` remains a valid identifier.

### 2. Forms

#### Auto-property (read-write)

```gs
class Person {
    prop Name string
}
```

No body — the compiler synthesizes a private backing field, a trivial getter, and a trivial setter. Emits:
- Field: `private string <Name>k__BackingField`
- Method: `public string get_Name()` → loads backing field
- Method: `public void set_Name(string value)` → stores to backing field
- PropertyDef row linking the two accessors

#### Auto-property (read-only)

```gs
class Person {
    prop Age int32 { get }
}
```

Body contains only a bare `get` (no block) — synthesizes a backing field and getter only. No setter is emitted. The backing field is set exclusively through construction (primary constructor parameter or struct literal).

#### Computed property (read-only)

```gs
class Person {
    prop FullName string {
        get { return this.first + " " + this.last }
    }
    private var first string
    private var last string
}
```

Getter has a block body — no backing field is synthesized. The getter body is bound and emitted as the `get_FullName` method body.

#### Computed property (read-write)

```gs
class Clamped {
    prop Value int32 {
        get { return this._value }
        set(v) {
            if v < 0 { this._value = 0 }
            else if v > 100 { this._value = 100 }
            else { this._value = v }
        }
    }
    private var _value int32
}
```

Both accessors have block bodies. The setter receives its incoming value via the parameter name in parentheses (defaults to `value` if omitted: `set { this._value = value }`).

#### Interface property requirement

```gs
interface Identifiable {
    prop Id string { get }
}

interface Named {
    prop Name string { get; set }
}
```

In interfaces, accessor declarations have no bodies — they express the contract. A `{ get }` requirement means implementors must provide at least a getter; `{ get; set }` requires both. A bare `prop X Type` in an interface is equivalent to `prop X Type { get; set }`.

### 3. Virtual and override properties

Classes support `open prop` and `override prop`, mirroring the existing `open func` / `override func` modifiers (ADR-0003, Phase 3.B.3):

```gs
open class Animal {
    open prop Name string {
        get { return "Animal" }
    }
}

class Dog : Animal {
    override prop Name string {
        get { return "Dog" }
    }
}
```

- `open prop` emits the accessor methods as `virtual` (CLR `newslot virtual`).
- `override prop` emits them as `override` (CLR `virtual` without `newslot`).
- A property may be `open` only in an `open class`.
- `override prop` must match the base property's accessor set — overriding a read-only property cannot add a setter.
- Abstract properties in interfaces are implicitly virtual; the implementing class's `prop` satisfies the interface without needing `override` (same as method interface implementation today).

Auto-properties can also be virtual:

```gs
open class Base {
    open prop Label string    // virtual auto-property
}

class Derived : Base {
    override prop Label string {
        get { return "custom: " + this._label }
        set(v) { this._label = v }
    }
    private var _label string
}
```

### 4. Accessibility

Properties inherit the accessibility of their enclosing type by default (`public` for types, `internal` for non-exported). An explicit accessibility modifier on the `prop` declaration applies to the property and both accessors uniformly:

```gs
class Foo {
    private prop secret int32       // private get + private set
    prop Name string                // public get + public set (class default)
}
```

An accessor may narrow the property's accessibility:

```gs
class Foo {
    prop Name string { get; private set; }
}
```

The getter remains public while `set_Name` is private in binding and CLR metadata.

### 5. Data struct interaction

Data struct fields remain fields:

```gs
data struct Point {
    var X int32    // field — unchanged
    var Y int32    // field — unchanged
}
```

A `data struct` may additionally declare `prop` members for computed values:

```gs
data struct Rect {
    var X int32
    var Y int32
    var Width int32
    var Height int32
    prop Area int32 { get { return this.Width * this.Height } }
}
```

Auto-properties are supported inside `data class` and `data struct`. Composite
literals target their setters/init accessors, while synthesized value equality,
hashing, formatting, and deconstruction use their backing fields.

### 6. Attribute targeting

ADR-0047's `@property:` use-site target applies to the `PropertyDef` metadata row. On a `prop` declaration:

- `@Foo` before `prop` → default target is `property`
- `@field:Foo` → targets the synthesized backing field (error if computed / no backing field)
- `@method:Foo` before `get`/`set` → targets that specific accessor method

```gs
@Obsolete("use FullName")
prop Name string

@field:NonSerialized
prop Cache object
```

### 7. Consumption syntax

Property access and assignment use the same dot syntax as field access — **callers are not affected**:

```gs
let p = Person("Alice", 30)
println(p.Name)     // calls get_Name
p.Name = "Bob"      // calls set_Name
```

This is already how imported CLR properties work (ADR-0034). User-defined properties follow the same binding path.

### 8. Interface satisfaction

A class implementing an interface with `prop` requirements must declare a `prop` with at least the required accessors. A field does **not** satisfy a property requirement — the CLR requires actual `get_X`/`set_X` methods:

```gs
interface Identifiable {
    prop Id string { get }
}

class User : Identifiable {
    prop Id string { get }   // satisfies — read-only auto-property
    // or: prop Id string    // also satisfies (has both get and set, superset is fine)
}
```

### 9. Emit strategy

Each `prop` declaration emits:
1. A `PropertyDef` row in the PE metadata with the property name, type signature, and accessor method tokens.
2. One or two `MethodDef` rows for `get_X` / `set_X`, marked `specialname` + `hidebysig`.
3. `MethodSemantics` rows linking property → accessor(s).
4. Optionally a `FieldDef` row for the backing field (auto-properties only), marked `private` and `CompilerGenerated`.

The emitter follows the exact same pattern that C# compilers emit, ensuring full round-trip compatibility with other CLR languages.

## Consequences

Positive:

- GSharp-defined types become fully compatible with CLR property consumers (WPF, serialization, analyzers, other languages).
- The `prop` keyword is explicit and unambiguous — Go philosophy of "no hidden behavior."
- Additive change — existing fields, data structs, and all current programs are unaffected.
- Interface properties enable GSharp types to implement CLR interfaces that require property accessors (`INotifyPropertyChanged.PropertyChanged`, `ICollection<T>.Count`, etc.).
- Annotation targeting (ADR-0047) already has the `property` target kind reserved.

Negative:

- New contextual keyword to learn — mitigated by its visibility only inside type bodies.
- Two ways to expose data on a type (field vs property) — style guidance will recommend `prop` for public API surface and fields for internal/private storage.

Neutral:

- The parser change is localized: inside `ParseStructDeclaration`'s member loop, check for contextual `prop` before falling through to field parsing.
- The binder must verify interface satisfaction includes property accessor matching — moderate complexity but well-understood from C# semantics.

## Alternatives considered

- **Field-with-accessor-block (Option A)**: `Name string { get; set }` — rejected because the difference between a field and a property becomes a trailing brace, which is subtle and error-prone. An explicit keyword is clearer.
- **Annotation-based (`@property` on methods, Option B)**: Rejected as too verbose, error-prone (naming conventions), and hostile to interface declarations.
- **`var`/`val` prefix (Option C)**: Rejected because GSharp uses `var`/`let` at statement scope with different semantics; reusing inside type bodies would confuse.
- **All fields auto-emit as properties (Option E)**: Rejected as a breaking change and contrary to Go's explicitness philosophy.
- **Uniform accessor visibility only**: Rejected because it cannot preserve common CLR property ABIs such as a public getter with a private setter.

## Follow-ups

- `prop` on extension declarations (extension properties).
- Interaction with `inline struct` (should inline structs allow computed properties?).
- `init`-only setter semantics (write-once in constructor, read-only thereafter).
