// <copyright file="Issue666ItemCls.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

namespace GSharp.Core.Tests.Fixtures;

/// <summary>
/// Issue #666 fixture: a simple CLR reference type from a "project reference"
/// assembly. When this assembly is supplied via <c>/reference:</c> (or loaded
/// through <see cref="System.Reflection.MetadataLoadContext"/> in a binder
/// test), using <c>ItemCls</c> as the element type of a generic collection
/// and then calling LINQ extension methods with instance syntax must succeed.
/// </summary>
public sealed class Issue666ItemCls
{
    public string Name { get; set; } = string.Empty;
}
