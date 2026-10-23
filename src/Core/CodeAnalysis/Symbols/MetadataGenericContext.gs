// <copyright file="MetadataGenericContext.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System.Collections.Immutable

/// The generic parameters in scope for a signature: those of the type (`!n`) and those of the method (`!!n`).
internal class MetadataGenericContext {
    internal init(typeParameters ImmutableArray[TypeSymbol], methodParameters ImmutableArray[TypeSymbol]) {
        TypeParameters = typeParameters
        MethodParameters = methodParameters
    }

    internal prop TypeParameters ImmutableArray[TypeSymbol]

    internal prop MethodParameters ImmutableArray[TypeSymbol]

    shared {
        /// The context of a signature with no generic parameters in scope.
        internal let Empty MetadataGenericContext = MetadataGenericContext(
            ImmutableArray[TypeSymbol].Empty,
            ImmutableArray[TypeSymbol].Empty
        )
    }
}
