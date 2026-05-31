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
