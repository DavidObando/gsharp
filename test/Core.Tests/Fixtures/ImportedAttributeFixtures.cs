// <copyright file="ImportedAttributeFixtures.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Core.Tests.Fixtures;

/// <summary>
/// A user-defined attribute carrying an explicit <see cref="AttributeUsageAttribute"/>.
/// Regression fixture for issue #288: when this assembly is supplied as a
/// reference, the compiler loads the type through a <c>MetadataLoadContext</c>,
/// so reading its <c>[AttributeUsage]</c> must use
/// <see cref="System.Reflection.CustomAttributeData"/> rather than runtime
/// reflection.
/// </summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, AllowMultiple = true, Inherited = true)]
public sealed class ImportedMarkerAttribute : Attribute
{
}

/// <summary>
/// A user-defined attribute with no explicit <see cref="AttributeUsageAttribute"/>.
/// Exercises the CLR default fallback (AttributeTargets.All / AllowMultiple =
/// false) for metadata-loaded attribute types.
/// </summary>
public sealed class ImportedDefaultAttribute : Attribute
{
}

/// <summary>
/// A user-defined enum used as the type of a custom-attribute named/positional
/// argument by <see cref="ImportedEnumArgAttribute"/>. Defined in a referenced
/// fixture assembly, so when consumed via the G# compiler's reference resolver
/// the enum type is reified through a <see cref="System.Reflection.MetadataLoadContext"/>.
/// </summary>
public enum ImportedAttributeMode
{
    /// <summary>The default mode.</summary>
    None = 0,

    /// <summary>An "info" mode.</summary>
    Info = 1,

    /// <summary>A "warning" mode.</summary>
    Warning = 2,
}

/// <summary>
/// Regression fixture for issue #418 (P1-8): an attribute whose named-arg
/// property is enum-typed. When applied to a G# declaration the emitter
/// writes the named enum argument into the custom-attribute blob, exercising
/// <c>WriteCustomAttributeFixedArg</c> with an enum <see cref="System.Type"/>
/// resolved through a <see cref="System.Reflection.MetadataLoadContext"/>.
/// The ctor is parameterless so the regression is scoped to the named-arg
/// path called out in the bug report.
/// </summary>
[AttributeUsage(AttributeTargets.All, AllowMultiple = false, Inherited = true)]
public sealed class ImportedEnumArgAttribute : Attribute
{
    /// <summary>Gets or sets a mode as a named argument.</summary>
    public ImportedAttributeMode Mode { get; set; }
}

/// <summary>
/// Regression fixture for issue #3892: an attribute whose POSITIONAL
/// constructor parameter is enum-typed. The emitter must encode that parameter
/// in the <c>.ctor</c> MemberRef signature as <c>VALUETYPE &lt;TypeRef&gt;</c>
/// naming the enum (ECMA-335 II.23.2.12), not as the enum's underlying type —
/// the underlying-type rule (II.23.3) governs only the value blob. Emitting
/// the underlying type produces a MemberRef the runtime cannot resolve.
/// </summary>
[AttributeUsage(AttributeTargets.All, AllowMultiple = false, Inherited = true)]
public sealed class ImportedEnumCtorAttribute : Attribute
{
    /// <summary>Initializes a new instance taking a positional enum argument.</summary>
    /// <param name="mode">The mode.</param>
    public ImportedEnumCtorAttribute(ImportedAttributeMode mode)
    {
        this.Mode = mode;
    }

    /// <summary>Gets the mode supplied positionally.</summary>
    public ImportedAttributeMode Mode { get; }
}

/// <summary>
/// Anti-vacuity partner to <see cref="ImportedEnumCtorAttribute"/> for issue
/// #3892: a constructor parameter that is genuinely <see cref="int"/> must
/// still encode as <c>ELEMENT_TYPE_I4</c>. A fix that encoded every integral
/// parameter as a value-type TypeRef would break this one.
/// </summary>
[AttributeUsage(AttributeTargets.All, AllowMultiple = false, Inherited = true)]
public sealed class ImportedInt32CtorAttribute : Attribute
{
    /// <summary>Initializes a new instance taking a positional int argument.</summary>
    /// <param name="value">The value.</param>
    public ImportedInt32CtorAttribute(int value)
    {
        this.Value = value;
    }

    /// <summary>Gets the value supplied positionally.</summary>
    public int Value { get; }
}

/// <summary>Attribute fixture with reserved and colliding CLR identifier names.</summary>
[AttributeUsage(AttributeTargets.All)]
public sealed class ImportedReservedNamedAttribute : Attribute
{
    /// <summary>Initializes a new instance.</summary>
    public ImportedReservedNamedAttribute(string @params, string params_)
    {
    }

    /// <summary>Gets or sets reserved-name data.</summary>
    public string @type { get; set; }

    /// <summary>Gets or sets colliding legal-name data.</summary>
    public string type_ { get; set; }
}

/// <summary>
/// A plain reference-assembly class used to verify that imports of non-System
/// namespaces resolve inside function and method bodies — not just in top-level
/// statements. Constructing this type or calling its members from within a
/// <c>func</c> body forces the function-body binder scope to use the
/// compilation's <see cref="System.Reflection.Assembly"/> references rather than
/// falling back to the core-only default resolver.
/// </summary>
public sealed class ImportedGreeter
{
    /// <summary>
    /// Greets the supplied name.
    /// </summary>
    /// <param name="name">The name to greet.</param>
    /// <returns>A greeting string.</returns>
    public string Greet(string name) => $"Hello, {name}!";
}
