// <copyright file="MetadataFunctionPointerTypeSymbol.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System.Collections.Immutable
import System.Reflection.Metadata

/// A function pointer type of an imported signature (`ELEMENT_TYPE_FNPTR`): the shape of the target signature.
/// @remarks A (cref:ReferenceImageSet) interns one object for each header and each list of return and parameter objects.
/// The `CallConv*` modifiers of the return type arrive with the custom modifiers, in a later stage. Until then this symbol
/// stands beside (cref:FunctionPointerTypeSymbol), which carries the source-level calling-convention model.
internal class MetadataFunctionPointerTypeSymbol : TypeSymbol {
    internal init(
        callingConvention SignatureCallingConvention,
        returnType TypeSymbol,
        parameterTypes ImmutableArray[TypeSymbol]
    ) : base("fnptr") {
        CallingConvention = callingConvention
        ReturnType = returnType
        ParameterTypes = parameterTypes
    }

    /// Gets the calling convention of the signature header.
    internal prop CallingConvention SignatureCallingConvention

    internal prop ReturnType TypeSymbol

    internal prop ParameterTypes ImmutableArray[TypeSymbol]
}
