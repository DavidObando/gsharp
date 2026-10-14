// <copyright file="OptionalValue.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import System

/// An optional constant value — the Roslyn `Optional<object>`
/// analogue used by `BoundExpression.ConstantValue` (ADR-0169), so
/// migrated analyzers' `HasValue`/`Value` idioms (including the
/// constant-null-literal check `HasValue && Value == null`) carry
/// over verbatim.
/// @param HasValue Whether a compile-time constant exists.
/// @param Value The constant value; may be null for a constant null literal.
data struct OptionalValue(HasValue bool, Value object?) : IEquatable[OptionalValue] { }
