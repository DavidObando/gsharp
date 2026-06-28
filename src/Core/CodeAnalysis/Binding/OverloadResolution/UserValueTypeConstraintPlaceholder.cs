// <copyright file="UserValueTypeConstraintPlaceholder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Core.CodeAnalysis.Binding.OverloadResolution;

/// <summary>
/// Issue #1325: a value-type stand-in used to close a generic method over a
/// same-compilation user value type under live reflection.
/// </summary>
internal struct UserValueTypeConstraintPlaceholder
{
}
