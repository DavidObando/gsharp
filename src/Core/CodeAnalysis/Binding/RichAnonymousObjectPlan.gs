// <copyright file="RichAnonymousObjectPlan.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Generic
import System.Collections.Immutable

internal class RichAnonymousObjectPlan {
    internal init(
        captureDescriptors ImmutableArray[(Name string, IsMutable bool, Field FieldSymbol)],
        referencedTypeParameters ImmutableArray[TypeParameterSymbol],
        methodBodies Dictionary[FunctionSymbol, BoundBlockStatement],
        methodDiagnostics ImmutableArray[Diagnostic]
    ) {
        CaptureDescriptors = captureDescriptors
        ReferencedTypeParameters = referencedTypeParameters
        MethodBodies = methodBodies
        MethodDiagnostics = methodDiagnostics
    }

    internal prop CaptureDescriptors ImmutableArray[(Name string, IsMutable bool, Field FieldSymbol)] {
        get;
    }

    internal prop ReferencedTypeParameters ImmutableArray[TypeParameterSymbol] {
        get;
    }

    internal prop MethodBodies Dictionary[FunctionSymbol, BoundBlockStatement] {
        get;
    }

    internal prop MethodDiagnostics ImmutableArray[Diagnostic] {
        get;
    }
}
