// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Immutable

internal class NativeProtocolBridge(
    protocol TypeSymbol,
    factory FunctionSymbol,
    matches FunctionSymbol,
    recover FunctionSymbol
) {
    internal prop Protocol TypeSymbol -> protocol
    internal prop Factory FunctionSymbol -> factory
    internal prop Matches FunctionSymbol -> matches
    internal prop Recover FunctionSymbol -> recover
}
