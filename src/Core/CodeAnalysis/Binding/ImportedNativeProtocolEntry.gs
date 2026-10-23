// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Generic
import System.Reflection
import System.Text.Json

internal class ImportedNativeProtocolDecision(
    protocol TypeSymbol,
    positive bool,
    fingerprint string,
    factory MethodInfo?,
    matches MethodInfo?,
    recover MethodInfo?
) {
    internal prop Protocol TypeSymbol -> protocol
    internal prop Positive bool -> positive
    internal prop Fingerprint string -> fingerprint
    internal prop Factory MethodInfo? -> factory
    internal prop Matches MethodInfo? -> matches
    internal prop Recover MethodInfo? -> recover
}

internal class ImportedNativeProtocolEntry(source TypeSymbol, origin string, record JsonElement) {
    internal prop SourceType TypeSymbol -> source
    internal prop Origin string -> origin
    internal prop Record JsonElement -> record
    private let decisions Dictionary[TypeSymbol, ImportedNativeProtocolDecision] =
    Dictionary[TypeSymbol, ImportedNativeProtocolDecision]()
    internal prop Decisions Dictionary[TypeSymbol, ImportedNativeProtocolDecision] -> decisions
}
