// <copyright file="GotoCleanupRegion.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

internal readonly record struct GotoCleanupRegion(
    FinallyClauseSyntax? FinallyClause,
    BoundStatement? CleanupStatement);
