// <copyright file="InlineOutVarArgumentMarker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Core.CodeAnalysis.Binding.OverloadResolution;

/// <summary>
/// Issue #977: private marker type whose <see cref="Type"/> identity is used as
/// the <see cref="ClrOverloadResolution.InlineOutVarArgumentType"/> sentinel.
/// </summary>
internal sealed class InlineOutVarArgumentMarker
{
}
