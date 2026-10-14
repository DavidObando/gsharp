// <copyright file="ImportedAttributeFixtures.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.Fixtures

import System
import System.Collections.Generic

/// A user-defined attribute carrying an explicit (cref:AttributeUsageAttribute).
/// Regression fixture for issue #288: when this assembly is supplied as a
/// reference, the compiler loads the type through a `MetadataLoadContext`,
/// so reading its `[AttributeUsage]` must use
/// (cref:System.Reflection.CustomAttributeData) rather than runtime
/// reflection.
@AttributeUsage(AttributeTargets.Method | AttributeTargets.Class, AllowMultiple = true, Inherited = true)
class ImportedMarkerAttribute : Attribute { }

/// A user-defined attribute with no explicit (cref:AttributeUsageAttribute).
/// Exercises the CLR default fallback (AttributeTargets.All / AllowMultiple =
/// false) for metadata-loaded attribute types.
class ImportedDefaultAttribute : Attribute { }

/// A user-defined enum used as the type of a custom-attribute named/positional
/// argument by (cref:ImportedEnumArgAttribute). Defined in a referenced
/// fixture assembly, so when consumed via the G# compiler's reference resolver
/// the enum type is reified through a (cref:System.Reflection.MetadataLoadContext).
enum ImportedAttributeMode {
    None,
    Info,
    Warning
}

/// Regression fixture for issue #418 (P1-8): an attribute whose named-arg
/// property is enum-typed. When applied to a G# declaration the emitter
/// writes the named enum argument into the custom-attribute blob, exercising
/// `WriteCustomAttributeFixedArg` with an enum (cref:System.Type)
/// resolved through a (cref:System.Reflection.MetadataLoadContext).
/// The ctor is parameterless so the regression is scoped to the named-arg
/// path called out in the bug report.
@AttributeUsage(AttributeTargets.All, AllowMultiple = false, Inherited = true)
class ImportedEnumArgAttribute : Attribute {
    /// Gets or sets a mode as a named argument.
    prop Mode ImportedAttributeMode
}

/// Regression fixture for issue #3892: an attribute whose POSITIONAL
/// constructor parameter is enum-typed. The emitter must encode that parameter
/// in the `.ctor` MemberRef signature as `VALUETYPE <TypeRef>`
/// naming the enum (ECMA-335 II.23.2.12), not as the enum's underlying type —
/// the underlying-type rule (II.23.3) governs only the value blob. Emitting
/// the underlying type produces a MemberRef the runtime cannot resolve.
@AttributeUsage(AttributeTargets.All, AllowMultiple = false, Inherited = true)
class ImportedEnumCtorAttribute : Attribute {
    /// Initializes a new instance taking a positional enum argument.
    /// @param mode The mode.
    init(mode ImportedAttributeMode) {
        this.Mode = mode
    }

    /// Gets the mode supplied positionally.
    prop Mode ImportedAttributeMode {
        get;
    }
}

/// Anti-vacuity partner to (cref:ImportedEnumCtorAttribute) for issue
/// #3892: a constructor parameter that is genuinely (cref:int) must
/// still encode as `ELEMENT_TYPE_I4`. A fix that encoded every integral
/// parameter as a value-type TypeRef would break this one.
@AttributeUsage(AttributeTargets.All, AllowMultiple = false, Inherited = true)
class ImportedInt32CtorAttribute : Attribute {
    /// Initializes a new instance taking a positional int argument.
    /// @param value The value.
    init(value int32) {
        this.Value = value
    }

    /// Gets the value supplied positionally.
    prop Value int32 {
        get;
    }
}

/// Attribute fixture with reserved and colliding CLR identifier names.
@AttributeUsage(AttributeTargets.All)
class ImportedReservedNamedAttribute : Attribute {
    /// Initializes a new instance.
    init($params string, params_ string) { }

    /// Gets or sets reserved-name data.
    prop type string

    /// Gets or sets colliding legal-name data.
    prop type_ string
}

/// A plain reference-assembly class used to verify that imports of non-System
/// namespaces resolve inside function and method bodies — not just in top-level
/// statements. Constructing this type or calling its members from within a
/// `func` body forces the function-body binder scope to use the
/// compilation's (cref:System.Reflection.Assembly) references rather than
/// falling back to the core-only default resolver.
class ImportedGreeter {
    /// Greets the supplied name.
    /// @param name The name to greet.
    /// @returns A greeting string.
    func Greet(name string) string -> "Hello, $name!"
}

/// ADR-0180 / issue #3785 regression fixture: an imported (plain, non-record)
/// CLR reference type whose only `Add` overload declares a TRAILING
/// `params` array after one fixed parameter. Not a semantic-aggregate
/// candidate (no `GSharp.TypeSemantics` marker, not a C# record shape),
/// so a composite literal targeting it always routes through the plain
/// imported-type literal binder rather than the semantic-aggregate path —
/// exercising the raw-reflection `ParameterInfo[]` capability probe
/// directly. `Add("x")` is callable with a single argument via normal
/// C#-style params expansion, so the probe must recognize it and let overload
/// resolution do the rest, rather than reject it up front.
class ImportedParamsAddCollection {
    private let items List[string] = List[string]()

    /// Gets or sets the explicit initializer member.
    prop Tag int32

    /// Gets the items added so far, in order.
    prop Items IReadOnlyList[string] -> items

    /// Adds [`item`](paramref), then each of [`rest`](paramref) in order.
    /// @param item The fixed leading item.
    /// @param rest Trailing variadic items.
    func Add(item string, rest ...string) {
        items.Add(item)
        items.AddRange(rest)
    }
}

/// A collection whose Add combines a trailing optional and params argument.
class ImportedOptionalParamsAddCollection {
    /// Gets or sets the explicit initializer member.
    prop Tag int32

    /// Gets the number of inserted items.
    prop Count int32 {
        get;
        private set;
    }

    /// Adds the supplied items.
    /// @param item The first item.
    /// @param trace An optional fixed argument.
    /// @param rest The trailing items.
    func Add(item string, trace bool = false, rest ...string) {
        Count += 1 + rest.Length
    }
}
