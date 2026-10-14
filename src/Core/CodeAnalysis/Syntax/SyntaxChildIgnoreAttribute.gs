// <copyright file="SyntaxChildIgnoreAttribute.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System

/// Marks a derived convenience property whose syntax nodes are already exposed
/// through another canonical child property.
@AttributeUsage(AttributeTargets.Property)
internal class SyntaxChildIgnoreAttribute : Attribute { }
