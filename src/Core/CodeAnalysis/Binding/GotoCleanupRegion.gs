// <copyright file="GotoCleanupRegion.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax
import System

internal data struct GotoCleanupRegion(
    FinallyClause FinallyClauseSyntax?,
    CleanupStatement BoundStatement?
) : IEquatable[GotoCleanupRegion] { }
