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
