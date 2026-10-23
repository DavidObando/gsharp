// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Immutable

internal class NativeProtocolCompilationPlan(
    operations ImmutableDictionary[TypeSymbol, NativeProtocolOperations],
    imports ImmutableArray[ImportedNativeProtocolEntry]
) {
    internal prop Operations ImmutableDictionary[TypeSymbol, NativeProtocolOperations] -> operations
    internal prop Imports ImmutableArray[ImportedNativeProtocolEntry] -> imports
}
