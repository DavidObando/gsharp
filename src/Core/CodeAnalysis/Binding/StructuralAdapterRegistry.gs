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
        ProtocolEntries = List[NativeProtocolEntryPlan]()
        ProtocolOperations = Dictionary[TypeSymbol, NativeProtocolOperations]()
        ImportedProtocolEntries = List[ImportedNativeProtocolEntry]()
        ProtocolQueries = List[NativeProtocolQuery]()
    }

    internal prop Counter int32

    internal prop Types List[StructSymbol] {
        get;
    }

    internal prop MethodBodies Dictionary[FunctionSymbol, BoundBlockStatement] {
        get;
    }

    internal prop ProtocolEntries List[NativeProtocolEntryPlan] {
        get;
    }

    internal prop ImportedProtocolEntries List[ImportedNativeProtocolEntry] {
        get;
    }
    internal prop ProtocolQueries List[NativeProtocolQuery] {
        get;
    }
    internal prop ProtocolOperations Dictionary[TypeSymbol, NativeProtocolOperations] {
        get;
    }
}
