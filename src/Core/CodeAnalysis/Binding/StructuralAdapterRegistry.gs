// <copyright file="StructuralAdapterRegistry.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Generic

internal class StructuralAdapterRegistry {
    init() {
        Types = List[StructSymbol]()
        MethodBodies = Dictionary[FunctionSymbol, BoundBlockStatement]()
    }

    internal prop Counter int32

    internal prop Types List[StructSymbol] {
        get;
    }

    internal prop MethodBodies Dictionary[FunctionSymbol, BoundBlockStatement] {
        get;
    }
}
