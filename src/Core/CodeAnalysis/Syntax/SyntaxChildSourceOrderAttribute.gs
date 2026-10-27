// <copyright file="SyntaxChildSourceOrderAttribute.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System

/// Marks a syntax node class whose child properties are not in source order for every shape of the
/// node. A `!!` suffix follows its operand, a type clause has prefix and suffix forms, and a
/// declaration lists its annotations in a base class. `GetChildren` sorts the children of a marked
/// class, and of its derived classes, by source position (issue #5185).
@AttributeUsage(AttributeTargets.Class)
internal class SyntaxChildSourceOrderAttribute : Attribute { }
