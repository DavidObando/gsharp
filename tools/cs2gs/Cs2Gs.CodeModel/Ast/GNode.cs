// <copyright file="GNode.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.CodeModel.Ast;

/// <summary>
/// Base type for every node in the G# emit AST. The model is intentionally
/// small and composable; later migration steps add nodes without disturbing
/// the canonical pretty-printer contract (ADR-0115 §B).
/// </summary>
public abstract class GNode
{
}
