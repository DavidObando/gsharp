// <copyright file="StructuralAdapterRegistry.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed class StructuralAdapterRegistry
{
    internal int Counter { get; set; }

    internal List<StructSymbol> Types { get; } = [];

    internal Dictionary<FunctionSymbol, BoundBlockStatement> MethodBodies { get; } = [];
}
