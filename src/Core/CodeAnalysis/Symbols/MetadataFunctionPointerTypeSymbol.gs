// <copyright file="MetadataFunctionPointerTypeSymbol.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System.Collections.Immutable
import System.Reflection.Metadata

/// A function pointer type of an imported signature (`ELEMENT_TYPE_FNPTR`): the shape of the target signature.
/// @remarks A (cref:ReferenceImageSet) interns one object for each full header, required count and list of return and parameter objects.
/// The `CallConv*` modifiers sit on the return type, as custom modifiers (see (cref:UnmanagedConventions)).
/// This symbol stands beside (cref:FunctionPointerTypeSymbol), which carries the source-level calling-convention model.
/// The adapter maps one onto the other: the unmanaged conventions are the names of (cref:UnmanagedConventions) without
/// the `CallConv` prefix, and the extended unmanaged model applies when there are any.
internal class MetadataFunctionPointerTypeSymbol : TypeSymbol {
    internal init(
        header SignatureHeader,
        requiredParameterCount int32,
        returnType TypeSymbol,
        parameterTypes ImmutableArray[TypeSymbol]
    ) : base("fnptr") {
        Header = header
        RequiredParameterCount = requiredParameterCount
        ReturnType = returnType
        ParameterTypes = parameterTypes
    }

    /// Gets the signature header: kind, calling convention, `this` and explicit `this`.
    internal prop Header SignatureHeader

    /// Gets the number of parameters before the vararg sentinel.
    internal prop RequiredParameterCount int32

    internal prop ReturnType TypeSymbol

    /// Gets the calling convention modifier types of the return type, in blob order.
    internal prop UnmanagedConventions ImmutableArray[TypeSymbol] -> MetadataModifiers.CallingConventions(ReturnType)

    internal prop ParameterTypes ImmutableArray[TypeSymbol]
}
