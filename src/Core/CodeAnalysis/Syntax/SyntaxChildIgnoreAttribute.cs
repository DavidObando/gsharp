// <copyright file="SyntaxChildIgnoreAttribute.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Marks a derived convenience property whose syntax nodes are already exposed
/// through another canonical child property.
/// </summary>
[AttributeUsage(AttributeTargets.Property)]
internal sealed class SyntaxChildIgnoreAttribute : Attribute
{
}
